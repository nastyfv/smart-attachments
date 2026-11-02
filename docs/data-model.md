# Модель данных - Smart Attachments

## Сущности

### Attachment (вложение)
Файл в папке `attachments`.

| Поле      | Тип                  | Описание                         |

| path      | string               | Путь относительно корня vault    |
| name      | string               | Имя файла с расширением          |
| ext       | string               | Расширение (pdf, jpg, docx)      |
| size      | number               | Размер в байтах                  |
| hash      | string               | SHA-256 хеш содержимого          |
| notePath  | string               | Путь к заметке-каталогу          |
| status    | `active` \| `orphan` | Статус: файл есть / удалён       |
| createdAt | string (ISO 8601)    | Дата создания записи             |
| deletedAt | string (ISO 8601)    | Дата удаления файла (для orphan) |

### Index (индекс)
Агрегат всех записей о вложениях.

| Поле     | Тип                        | Описание                               |

| index    | Record<string, Attachment> | Ключ - путь к файлу, значение - запись |
| settings | object                     | Настройки плагина                      |

## Связи

- Один Attachment → одна заметка-каталог (1:1).
- Один Attachment → ноль или более обратных ссылок из других заметок (1:N) - задел на v2.

## Хранение

Индекс и настройки хранятся в `data.json` в папке плагина: .obsidian/plugins/smart-attachments/data.json

## ERD (диаграмма связей)

![ERD Smart Attachments](images/erd.png)

Пример содержимого:

```json
{
  "settings": {
    "attachmentsFolder": "attachments",
    "catalogFolder": "catalog"
  },
  "index": {
    "attachments/picture.jpg": {
      "path": "attachments/picture.jpg",
      "name": "picture.jpg",
      "ext": "jpg",
      "size": 245678,
      "hash": "abc123...",
      "notePath": "catalog/picture.md",
      "status": "active",
      "createdAt": "2026-11-02T14:36:00.000Z"
    }
  }
}

Жизненный цикл записи

[создание файла]       → status: active
        ↓
[переименование файла] → status: active (обновлены path и name)
        ↓
[удаление файла]       → status: orphan (добавлен deletedAt)
        ↓
[Delete all orphan notes] → запись удалена из индекса

Ограничения

1.Дубликаты по хешу не создают вторую заметку.
2.Ручное удаление заметки из catalog не синхронизируется с индексом автоматически.
3.Хеш считается для файла любого размера. Для файлов > 100 МБ это может замедлить Obsidian на несколько секунд. В v2 планируется пропускать хеширование для больших файлов