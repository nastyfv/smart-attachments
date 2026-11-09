// ============================================================
// Smart Attachments — плагин для Obsidian
// v2: группировка по типу файла + теги по типу
// ============================================================

import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, normalizePath } from 'obsidian';
import * as crypto from 'crypto';

// ─── Категория файла по расширению ──────────────────────────
function getFileCategory(ext: string): { folder: string; tag: string } {
    const extLower = ext.toLowerCase();
    const mapping: Record<string, { folder: string; tag: string }> = {
        jpg:  { folder: 'images',    tag: 'image' },
        jpeg: { folder: 'images',    tag: 'image' },
        png:  { folder: 'images',    tag: 'image' },
        gif:  { folder: 'images',    tag: 'image' },
        svg:  { folder: 'images',    tag: 'image' },
        webp: { folder: 'images',    tag: 'image' },
        bmp:  { folder: 'images',    tag: 'image' },
        ico:  { folder: 'images',    tag: 'image' },

        pdf:  { folder: 'documents', tag: 'document' },
        doc:  { folder: 'documents', tag: 'document' },
        docx: { folder: 'documents', tag: 'document' },
        xls:  { folder: 'documents', tag: 'document' },
        xlsx: { folder: 'documents', tag: 'document' },
        ppt:  { folder: 'documents', tag: 'document' },
        pptx: { folder: 'documents', tag: 'document' },
        txt:  { folder: 'documents', tag: 'document' },
        rtf:  { folder: 'documents', tag: 'document' },
        md:   { folder: 'documents', tag: 'document' },
        csv:  { folder: 'documents', tag: 'document' },

        mp3:  { folder: 'audio', tag: 'audio' },
        wav:  { folder: 'audio', tag: 'audio' },
        ogg:  { folder: 'audio', tag: 'audio' },
        flac: { folder: 'audio', tag: 'audio' },
        m4a:  { folder: 'audio', tag: 'audio' },

        mp4:  { folder: 'video', tag: 'video' },
        mov:  { folder: 'video', tag: 'video' },
        avi:  { folder: 'video', tag: 'video' },
        mkv:  { folder: 'video', tag: 'video' },
        webm: { folder: 'video', tag: 'video' },

        zip:  { folder: 'archives', tag: 'archive' },
        rar:  { folder: 'archives', tag: 'archive' },
        '7z': { folder: 'archives', tag: 'archive' },
        tar:  { folder: 'archives', tag: 'archive' },
        gz:   { folder: 'archives', tag: 'archive' },
    };
    return mapping[extLower] || { folder: 'other', tag: 'other' };
}

// ─── Настройки ───────────────────────────────────────────────
interface SmartAttachmentsSettings {
    attachmentsFolder: string;
    catalogFolder: string;
    groupByType: boolean;
}

const DEFAULT_SETTINGS: SmartAttachmentsSettings = {
    attachmentsFolder: 'attachments',
    catalogFolder: 'catalog',
    groupByType: true,
};

// ─── Типы данных ─────────────────────────────────────────────
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

interface PluginData {
    settings: SmartAttachmentsSettings;
    index: Record<string, IndexEntry>;
}

// ─── Плагин ──────────────────────────────────────────────────
export default class SmartAttachmentsPlugin extends Plugin {
    data: PluginData;

    async onload() {
        await this.loadPluginData();

        this.registerEvent(
            this.app.vault.on('create', async (file) => {
                if (!(file instanceof TFile)) return;
                if (!this.isInAttachments(file.path)) return;
                await this.processNewFile(file);
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (!(file instanceof TFile)) return;
                if (!this.isInAttachments(file.path)) return;
                await this.processRename(file, oldPath);
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', async (file) => {
                if (!(file instanceof TFile)) return;
                if (!this.isInAttachments(file.path)) return;
                await this.processDelete(file);
            })
        );

        this.addCommand({
            id: 'rebuild-index',
            name: 'Rebuild attachments index',
            callback: async () => { await this.rebuildIndex(); },
        });

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

        this.addSettingTab(new SmartAttachmentsSettingTab(this.app, this));
        new Notice('Smart Attachments loaded');
    }

    isInAttachments(path: string): boolean {
        const folder = normalizePath(this.data.settings.attachmentsFolder);
        return path.startsWith(folder + '/');
    }

    getExpectedNotePath(fileName: string, ext: string): string {
        const catalogFolder = normalizePath(this.data.settings.catalogFolder);
        let targetFolder = catalogFolder;
        if (this.data.settings.groupByType) {
            const category = getFileCategory(ext);
            targetFolder = normalizePath(`${catalogFolder}/${category.folder}`);
        }
        const noteName = fileName.replace(/\.[^/.]+$/, '') + '.md';
        return normalizePath(`${targetFolder}/${noteName}`);
    }

    async processNewFile(file: TFile) {
        const hash = await this.computeHash(file);
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

    async processRename(file: TFile, oldPath: string) {
        const entry = this.data.index[oldPath];
        if (!entry) return;

        const oldFilePath = entry.path;
        const oldName = entry.name;

        delete this.data.index[oldPath];
        entry.path = file.path;
        entry.name = file.name;
        this.data.index[file.path] = entry;

        const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
        if (noteFile instanceof TFile) {
            let content = await this.app.vault.read(noteFile);
            content = content.split(oldFilePath).join(file.path);
            content = content.split(`name: "${oldName}"`).join(`name: "${file.name}"`);
            content = content.split(`# ${oldName}`).join(`# ${file.name}`);
            await this.app.vault.modify(noteFile, content);
        }

        await this.savePluginData();
    }

    async processDelete(file: TFile) {
        const entry = this.data.index[file.path];
        if (!entry) return;

        entry.status = 'orphan';
        entry.deletedAt = new Date().toISOString();

        const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
        if (noteFile instanceof TFile) {
            let content = await this.app.vault.read(noteFile);
            content = content.replace('status: active', 'status: orphan');
            await this.app.vault.modify(noteFile, content);
        }

        await this.savePluginData();
    }

    async createCatalogNote(file: TFile, hash: string): Promise<string> {
        const category = getFileCategory(file.extension);
        const notePath = this.getExpectedNotePath(file.name, file.extension);
        const targetFolder = notePath.substring(0, notePath.lastIndexOf('/'));

        if (!this.app.vault.getAbstractFileByPath(targetFolder)) {
            await this.app.vault.createFolder(targetFolder);
        }

        const content = `---
attachment_id: "${hash.slice(0, 8)}"
file: "${file.path}"
name: "${file.name}"
ext: "${file.extension}"
size: ${file.stat.size}
hash: "${hash}"
created: "${new Date().toISOString()}"
status: active
tags: [attachment, ${category.tag}]
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

    async computeHash(file: TFile): Promise<string> {
        const buffer = await this.app.vault.readBinary(file);
        return crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex');
    }

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
        let moved = 0;

        // 1. Миграция: переместить существующие заметки в правильные подпапки
        for (const entry of Object.values(this.data.index)) {
            if (entry.status !== 'active') continue;

            const noteFile = this.app.vault.getAbstractFileByPath(entry.notePath);
            if (!(noteFile instanceof TFile)) continue;

            const expectedPath = this.getExpectedNotePath(entry.name, entry.ext);
            if (entry.notePath === expectedPath) continue;

            if (this.app.vault.getAbstractFileByPath(expectedPath)) continue;

            const targetFolder = expectedPath.substring(0, expectedPath.lastIndexOf('/'));
            if (!this.app.vault.getAbstractFileByPath(targetFolder)) {
                await this.app.vault.createFolder(targetFolder);
            }

            await this.app.vault.rename(noteFile, expectedPath);
            entry.notePath = expectedPath;
            moved++;
        }

        // 2. Создать недостающие заметки
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

        // 3. Пометить пропавшие файлы как orphan
        for (const entry of Object.values(this.data.index)) {
            if (entry.status === 'active' && !this.app.vault.getAbstractFileByPath(entry.path)) {
                entry.status = 'orphan';
                entry.deletedAt = new Date().toISOString();
                orphans++;
            }
        }

        await this.savePluginData();
        new Notice(`Rebuild done: created ${created}, orphans ${orphans}, moved ${moved}`);
    }

    async loadPluginData() {
        const loaded = (await this.loadData()) || {};
        this.data = {
            settings: Object.assign({}, DEFAULT_SETTINGS, loaded.settings || {}),
            index: loaded.index || {},
        };
    }

    async savePluginData() {
        await this.saveData(this.data);
    }
}

// ─── Вкладка настроек ────────────────────────────────────────
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

        new Setting(containerEl)
            .setName('Group by type')
            .setDesc('Раскладывать заметки по подпапкам (images/, documents/, audio/, video/, archives/, other/). После изменения настройки запустите "Rebuild attachments index".')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.data.settings.groupByType)
                    .onChange(async (value) => {
                        this.plugin.data.settings.groupByType = value;
                        await this.plugin.savePluginData();
                    })
            );
    }
}