// ============================================================
// Smart Attachments — плагин для Obsidian
// Автоматически создаёт заметку-каталог для каждого вложения
// ============================================================

import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, normalizePath } from 'obsidian';
import * as crypto from 'crypto';

// Настройки плагина
interface SmartAttachmentsSettings {
    attachmentsFolder: string;  // папка с файлами
    catalogFolder: string;      // папка для заметок-каталога
}

// Значения по умолчанию
const DEFAULT_SETTINGS: SmartAttachmentsSettings = {
    attachmentsFolder: 'attachments',
    catalogFolder: 'catalog',
};

// Запись в индексе — одно вложение
interface IndexEntry {
    path: string;
    name: string;
    ext: string;
    size: number;
    hash: string;
    notePath: string;
    status: 'active' | 'orphan';
    createdAt: string;
    deletedAt?: string;
}

// Данные, которые сохраняются на диск
interface PluginData {
    settings: SmartAttachmentsSettings;
    index: Record<string, IndexEntry>;
}

export default class SmartAttachmentsPlugin extends Plugin {
    data: PluginData;

    async onload() {
        // Загружаем настройки и индекс с диска
        await this.loadPluginData();

        // Событие: создан новый файл
        this.registerEvent(
            this.app.vault.on('create', async (file) => {
                if (!(file instanceof TFile)) return;
                if (!this.isInAttachments(file.path)) return;
                await this.processNewFile(file);
            })
        );

        // Событие: файл переименован
        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (!(file instanceof TFile)) return;
                if (!this.isInAttachments(file.path)) return;
                await this.processRename(file, oldPath);
            })
        );

        // Событие: файл удалён
        this.registerEvent(
            this.app.vault.on('delete', async (file) => {
                if (!(file instanceof TFile)) return;
                if (!this.isInAttachments(file.path)) return;
                await this.processDelete(file);
            })
        );

        // Команда: пересобрать индекс
        this.addCommand({
            id: 'rebuild-index',
            name: 'Rebuild attachments index',
            callback: async () => {
                await this.rebuildIndex();
            },
        });

                // Команда: удалить все orphan-заметки
        this.addCommand({
            id: 'delete-orphan-notes',
            name: 'Delete all orphan notes',
            callback: async () => {
                let deleted = 0;
                for (const [path, entry] of Object.entries(this.data.index)) {
                    if (entry.status === 'orphan') {
                        const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
                        if (noteFile instanceof TFile) {
                            await this.app.vault.delete(noteFile);
                        }
                        delete this.data.index[path];
                        deleted++;
                    }
                }
                await this.savePluginData();
                new Notice(`Deleted ${deleted} orphan notes`);
            },
        });
        
        // Вкладка настроек
        this.addSettingTab(new SmartAttachmentsSettingTab(this.app, this));

        new Notice('Smart Attachments loaded');
    }

    // Проверка: файл лежит в папке вложений?
    isInAttachments(path: string): boolean {
        const folder = normalizePath(this.data.settings.attachmentsFolder);
        return path.startsWith(folder + '/');
    }

    // Новый файл — создаём заметку
    async processNewFile(file: TFile) {
        const hash = await this.computeHash(file);

        // Если такой же файл уже есть — пропускаем (защита от дублей)
        const existing = Object.values(this.data.index).find(
            (e) => e.hash === hash && e.status === 'active'
        );
        if (existing) return;

        const notePath = await this.createCatalogNote(file, hash);

        this.data.index[file.path] = {
            path: file.path,
            name: file.name,
            ext: file.extension,
            size: file.stat.size,
            hash: hash,
            notePath: notePath,
            status: 'active',
            createdAt: new Date().toISOString(),
        };
        await this.savePluginData();
    }

      // Файл переименован — обновляем запись в индексе и саму заметку
    async processRename(file: TFile, oldPath: string) {
        console.log('[SmartAttachments] rename called:', oldPath, '->', file.path);

        const entry = this.data.index[oldPath];
        if (!entry) {
            console.log('[SmartAttachments] entry not found in index for oldPath:', oldPath);
            return;
        }

        const oldFilePath = entry.path;
        const oldName = entry.name;

        // Обновляем запись в индексе
        delete this.data.index[oldPath];
        entry.path = file.path;
        entry.name = file.name;
        this.data.index[file.path] = entry;

        // Обновляем содержимое заметки
        const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
        if (noteFile instanceof TFile) {
            console.log('[SmartAttachments] updating note:', entry.notePath);

            let content = await this.app.vault.read(noteFile);

            // Заменяем старый путь на новый
            content = content.split(oldFilePath).join(file.path);

            // Обновляем имя файла в метаданных
            content = content.split(`name: "${oldName}"`).join(`name: "${file.name}"`);

            // Обновляем заголовок
            content = content.split(`# ${oldName}`).join(`# ${file.name}`);

            await this.app.vault.modify(noteFile, content);

            console.log('[SmartAttachments] note updated');
        } else {
            console.log('[SmartAttachments] note file not found at path:', entry.notePath);
        }

        await this.savePluginData();
    }

    // Файл удалён — помечаем заметку как orphan
    async processDelete(file: TFile) {
        const entry = this.data.index[file.path];
        if (!entry) return;

        entry.status = 'orphan';
        entry.deletedAt = new Date().toISOString();

        // Обновляем саму заметку: меняем статус на orphan
        const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
        if (noteFile instanceof TFile) {
            let content = await this.app.vault.read(noteFile);
            content = content.replace('status: active', 'status: orphan');
            await this.app.vault.modify(noteFile, content);
        }

        await this.savePluginData();
    }

    // Создаём заметку-каталог по шаблону
    async createCatalogNote(file: TFile, hash: string): Promise<string> {
        const catalogFolder = normalizePath(this.data.settings.catalogFolder);

        // Создаём папку каталога, если её нет
        if (!this.app.vault.getAbstractFileByPath(catalogFolder)) {
            await this.app.vault.createFolder(catalogFolder);
        }

        const noteName = file.name.replace(/\.[^/.]+$/, '') + '.md';
        const notePath = normalizePath(`${catalogFolder}/${noteName}`);

        const content = `---
attachment_id: "${hash.slice(0, 8)}"
file: "${file.path}"
name: "${file.name}"
ext: "${file.extension}"
size: ${file.stat.size}
hash: "${hash}"
created: "${new Date().toISOString()}"
status: active
tags: [attachment]
---

# ${file.name}

![[${file.path}]]

## Метаданные

- Размер: ${file.stat.size} байт
- Тип: ${file.extension}
- Хеш: \`${hash}\`

## Обратные ссылки

<!-- будут добавлены в следующей версии -->
`;

        await this.app.vault.create(notePath, content);
        return notePath;
    }

    // Считаем SHA-256 хеш файла
    async computeHash(file: TFile): Promise<string> {
        const buffer = await this.app.vault.readBinary(file);
        return crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    }

    // Пересборка индекса: сканируем папку вложений заново
    async rebuildIndex() {
        const folder = this.app.vault.getAbstractFileByPath(
            normalizePath(this.data.settings.attachmentsFolder)
        );
        if (!folder) {
            new Notice('Attachments folder not found');
            return;
        }

        let created = 0;
        let orphans = 0;

        // Добавляем недостающие заметки
        const files = this.app.vault.getFiles().filter((f) => this.isInAttachments(f.path));
        for (const file of files) {
            if (!this.data.index[file.path]) {
                const hash = await this.computeHash(file);
                const notePath = await this.createCatalogNote(file, hash);
                this.data.index[file.path] = {
                    path: file.path,
                    name: file.name,
                    ext: file.extension,
                    size: file.stat.size,
                    hash: hash,
                    notePath: notePath,
                    status: 'active',
                    createdAt: new Date().toISOString(),
                };
                created++;
            }
        }

        // Помечаем пропавшие файлы как orphan
        for (const entry of Object.values(this.data.index)) {
            if (entry.status === 'active' && !this.app.vault.getAbstractFileByPath(entry.path)) {
                entry.status = 'orphan';
                entry.deletedAt = new Date().toISOString();
                orphans++;
            }
        }

        await this.savePluginData();
        new Notice(`Rebuild done: created ${created}, orphans ${orphans}`);
    }

    // Загрузка данных с диска
    async loadPluginData() {
        const loaded = (await this.loadData()) || {};
        this.data = {
            settings: Object.assign({}, DEFAULT_SETTINGS, loaded.settings || {}),
            index: loaded.index || {},
        };
    }

    // Сохранение данных на диск
    async savePluginData() {
        await this.saveData(this.data);
    }
}

// Вкладка настроек плагина
class SmartAttachmentsSettingTab extends PluginSettingTab {
    plugin: SmartAttachmentsPlugin;

    constructor(app: App, plugin: SmartAttachmentsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Smart Attachments' });

        new Setting(containerEl)
            .setName('Attachments folder')
            .setDesc('Папка с вложениями (относительно корня vault)')
            .addText((text) =>
                text
                    .setPlaceholder('attachments')
                    .setValue(this.plugin.data.settings.attachmentsFolder)
                    .onChange(async (value) => {
                        this.plugin.data.settings.attachmentsFolder = value;
                        await this.plugin.savePluginData();
                    })
            );

        new Setting(containerEl)
            .setName('Catalog folder')
            .setDesc('Папка для заметок-каталога')
            .addText((text) =>
                text
                    .setPlaceholder('catalog')
                    .setValue(this.plugin.data.settings.catalogFolder)
                    .onChange(async (value) => {
                        this.plugin.data.settings.catalogFolder = value;
                        await this.plugin.savePluginData();
                    })
            );
    }
}