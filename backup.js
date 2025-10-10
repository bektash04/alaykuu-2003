const path = require('path');
const fs = require('fs');
const dayjs = require('dayjs');
const sqlite3 = require('sqlite3').verbose();

const DB = path.join(__dirname, 'tickets.db');
const OUT_DIR = path.join(__dirname, 'backups');

fs.mkdirSync(OUT_DIR, { recursive: true });

const stamp = dayjs().format('YYYY-MM-DD_HHmm');
const dest = path.join(OUT_DIR, `tickets_${stamp}.db`);

const db = new sqlite3.Database(DB);

db.serialize(() => {
  // На всякий случай: сброс WAL в основной файл
  db.run("PRAGMA wal_checkpoint(PASSIVE)");

  // Консистентная копия базы
  db.run("VACUUM INTO ?", [dest], (err) => {
    if (err) {
      console.error('Backup failed:', err.message);
      process.exit(1);
    }
    console.log('Backup saved to:', dest);

    // Ротация: оставим только 14 последних копий
    const files = fs.readdirSync(OUT_DIR)
      .filter(f => f.endsWith('.db'))
      .sort()        // по имени, у нас в имени дата => сортировка = по времени
      .reverse();    // новые сначала

    files.slice(14).forEach(f => {
      fs.unlinkSync(path.join(OUT_DIR, f));
    });

    db.close();
  });
});