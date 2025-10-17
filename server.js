// ===== Подключаем .env =====
require('dotenv').config();

// ===== Импорты =====
const express       = require('express');
const path          = require('path');
const fs            = require('fs');
const sqlite3       = require('sqlite3').verbose();
const dayjs         = require('dayjs');
const QRCode        = require('qrcode');
const Handlebars    = require('handlebars');
const puppeteer     = require('puppeteer');
const cookieSession = require('cookie-session');

// ===== Среда/пути данных (Railway/локально) =====
const IS_PROD  = !!process.env.RAILWAY_STATIC_URL || process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || (IS_PROD ? '/app/data' : path.join(__dirname, 'data'));
const DB_PATH  = path.join(DATA_DIR, 'tickets.db');
const OUT_DIR  = path.join(DATA_DIR, 'generated');

// Гарантируем папки
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR,  { recursive: true });

// ===== Приложение =====
const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cookieSession({
  name: 'sess',
  keys: [process.env.SESSION_SECRET || 'dev-secret-key'],
  maxAge: 12 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
}));

// ===== Конфиг админки (логин/пароль) =====
const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || 'alaikuu0527').trim();

// ===== Конфиг события =====
const MAX_TICKETS       = 200;
const EVENT_NAME        = 'Алайкуу жолугуушу';
const EVENT_TIME        = '16:00';
const VENUE             = 'Проспект Победы, 315';
const ORGANIZER_NAME    = 'Уюштуруучу топ 2003';
const ORGANIZER_CONTACT = '+996 700 686 985';

// ===== Авторизация =====
function wantsJSON(req) {
  return req.path.startsWith('/api') ||
         req.xhr ||
        (req.headers.accept || '').toLowerCase().includes('application/json');
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (wantsJSON(req)) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

// ===== База данных =====
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON`);
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA busy_timeout = 5000`);

  db.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      event_name TEXT,
      buyer_name TEXT,
      ticket_category TEXT,
      seat TEXT,
      status TEXT,
      issued_at TEXT,
      used_at TEXT,
      serial_no INTEGER
    )
  `);

  // Миграция/уникальный индекс по serial_no
  db.all(`PRAGMA table_info(tickets)`, (err, cols) => {
    if (err) return console.error('PRAGMA table_info error:', err);
    const hasSerial = Array.isArray(cols) && cols.some(c => c.name === 'serial_no');

    const ensureIndex = () => {
      db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_tickets_serial_no
           ON tickets(serial_no) WHERE serial_no IS NOT NULL`
      );
    };

    if (!hasSerial) {
      db.run(`ALTER TABLE tickets ADD COLUMN serial_no INTEGER`, (e) => {
        if (e) console.error('ALTER add serial_no failed:', e.message);
        else console.log('Migrated: serial_no column added');
        ensureIndex();
      });
    } else {
      ensureIndex();
    }
  });

  // Пул номеров
  db.run(`
    CREATE TABLE IF NOT EXISTS ticket_numbers (
      number INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'free', -- free | used
      ticket_id TEXT,
      buyer_name TEXT,
      assigned_at TEXT
    )
  `);

  // Засеять номера
  db.get(`SELECT COUNT(*) AS c FROM ticket_numbers`, (err, row) => {
    if (err) return console.error('Seed check error:', err);
    if (row && row.c === 0) {
      const insert = db.prepare(`INSERT INTO ticket_numbers (number) VALUES (?)`);
      for (let i = 1; i <= MAX_TICKETS; i++) insert.run(i);
      insert.finalize(() => console.log(`Seeded ${MAX_TICKETS} ticket numbers`));
    }
  });

  // Индекс по времени
  db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_issued_at ON tickets(issued_at)`);
});

// ===== Утилиты PDF =====
function makeTicketId() {
  const date = dayjs().format('YYYYMMDD');
  const rand = Math.floor(Math.random() * 36 ** 8).toString(36).toUpperCase().padStart(8, '0');
  return `TCK-${date}-${rand}`;
}

const template = (() => {
  const tplPath = path.join(__dirname, 'views', 'ticket_template.html');
  const html = fs.readFileSync(tplPath, 'utf8');
  return Handlebars.compile(html, { noEscape: true });
})();

async function makeQrDataUrl(payload) {
  return QRCode.toDataURL(payload, { margin: 1, width: 600 });
}

function imageAsDataUrl(relPathFromPublic) {
  try {
    const abs = path.join(__dirname, 'public', relPathFromPublic);
    const buf = fs.readFileSync(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === '.png'  ? 'image/png'  :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn('Logo not found:', relPathFromPublic, e.message);
    return null;
  }
}

// ждём, пока PDF допишется
function waitForFile(filePath, timeoutMs = 5000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      fs.access(filePath, fs.constants.R_OK, (err) => {
        if (!err) return resolve(true);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(poll, intervalMs);
      });
    })();
  });
}

async function renderPdf(ticket) {
  const data = {
    event_name: EVENT_NAME,
    event_tagline: '2025',
    buyer_name: ticket.buyer_name,
    ticket_category: ticket.ticket_category || 'Standard',
    event_date_human: dayjs('2025-11-09').format('DD.MM.YYYY'),
    event_time_human: EVENT_TIME,
    venue: VENUE,
    seat: ticket.seat || 'Орундар эркин тандалат',
    ticket_id: ticket.id,
    serial_no: ticket.serial_no,
    organizer_name: ORGANIZER_NAME,
    organizer_contact: ORGANIZER_CONTACT,
    year: dayjs().year(),
    logo_data_url: imageAsDataUrl('img/logo.png'),
    qr_data_url: await makeQrDataUrl(JSON.stringify({ ticket_id: ticket.id, event: EVENT_NAME })),
  };

  const outPdf = path.resolve(OUT_DIR, `${ticket.id}.pdf`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent(template(data), { waitUntil: ['domcontentloaded', 'networkidle0'] });
  await page.pdf({ path: outPdf, printBackground: true, preferCSSPageSize: true });
  await browser.close();

  return outPdf;
}

// ===== API (АДМИН — под паролем) =====

// Создать билет + занять номер + PDF
app.post('/api/tickets', requireAuth, (req, res) => {
  const {
    buyer_name,
    ticket_category = 'Standard',
    seat = 'Орундар эркин тандалат',
    serial_no,
  } = req.body || {};

  if (!buyer_name || buyer_name.trim().length < 2) {
    return res.status(400).json({ error: 'Укажи имя покупателя (минимум 2 символа).' });
  }

  const id = makeTicketId();
  const issued_at = dayjs().toISOString();
  const status = 'issued';
  const requestedNo = Number(serial_no) > 0 ? Number(serial_no) : null;

  db.run('BEGIN IMMEDIATE TRANSACTION', (beginErr) => {
    if (beginErr) return res.status(500).json({ error: 'DB begin failed' });

    const assignNumber = (num) => {
      db.run(
        `UPDATE ticket_numbers
           SET status='used', ticket_id=?, buyer_name=?, assigned_at=?
         WHERE number=? AND status='free'`,
        [id, buyer_name.trim(), issued_at, num],
        function (updErr) {
          if (updErr) { db.run('ROLLBACK'); return res.status(500).json({ error: 'DB update failed' }); }
          if (this.changes === 0) { db.run('ROLLBACK'); return res.status(409).json({ error: 'Номер недоступен, выбери другой или оставь пустым' }); }

          db.run(
            `INSERT INTO tickets
              (id, event_name, buyer_name, ticket_category, seat, status, issued_at, serial_no)
             VALUES (?,?,?,?,?,?,?,?)`,
            [id, EVENT_NAME, buyer_name.trim(), ticket_category, seat, status, issued_at, num],
            async (insErr) => {
              if (insErr) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Insert ticket failed' }); }

              db.run('COMMIT', async (commitErr) => {
                if (commitErr) return res.status(500).json({ error: 'DB commit failed' });
                try {
                  await renderPdf({ id, buyer_name, ticket_category, seat, serial_no: num });
                  res.json({
                    ok: true,
                    ticket: { id, buyer_name, status, serial_no: num },
                    pdf_url: `/download/${id}`,
                    pdf_view_url: `/view/${id}`,
                  });
                } catch (e) {
                  console.error(e);
                  res.status(500).json({ error: 'Не удалось сгенерировать PDF' });
                }
              });
            }
          );
        }
      );
    };

    if (requestedNo) {
      if (requestedNo < 1 || requestedNo > MAX_TICKETS) {
        db.run('ROLLBACK');
        return res.status(400).json({ error: `Номер должен быть от 1 до ${MAX_TICKETS}` });
      }
      assignNumber(requestedNo);
    } else {
      db.get(
        `SELECT number FROM ticket_numbers WHERE status='free' ORDER BY number LIMIT 1`,
        (selErr, row) => {
          if (selErr) { db.run('ROLLBACK'); return res.status(500).json({ error: 'DB select failed' }); }
          if (!row)   { db.run('ROLLBACK'); return res.status(409).json({ error: 'Свободных номеров не осталось' }); }
          assignNumber(row.number);
        }
      );
    }
  });
});

// Остатки номеров
app.get('/api/numbers/summary', requireAuth, (_req, res) => {
  db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='free' THEN 1 ELSE 0 END) AS free
       FROM ticket_numbers`,
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      const total = row.total || 0;
      const free  = row.free  || 0;
      res.json({ total, free, used: total - free });
    }
  );
});

// Ближайшие свободные
app.get('/api/numbers/free', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  db.all(
    `SELECT number FROM ticket_numbers WHERE status='free' ORDER BY number LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ numbers: rows.map(r => r.number) });
    }
  );
});

// История продаж
app.get('/api/tickets/recent', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  db.all(
    `SELECT id, serial_no, buyer_name, ticket_category, status, issued_at
       FROM tickets
       ORDER BY datetime(issued_at) DESC
       LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ tickets: rows });
    }
  );
});

// Статистика продаж
app.get('/api/tickets/stats', requireAuth, (_req, res) => {
  db.all(
    `SELECT ticket_category AS category, COUNT(*) AS cnt
       FROM tickets GROUP BY ticket_category`,
    (err, catRows) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT COUNT(*) AS total FROM tickets`, (err2, totalRow) => {
        if (err2) return res.status(500).json({ error: err2.message });
        const by_category = {};
        (catRows || []).forEach(r => { by_category[r.category || '—'] = r.cnt; });
        res.json({ total: totalRow?.total || 0, by_category });
      });
    }
  );
});

// Экспорт CSV
function csvEscape(v){ if(v==null) return ''; const s=String(v).replace(/"/g,'""'); return `"${s}"`; }
app.get('/export.csv', requireAuth, (_req, res) => {
  db.all(
    `SELECT serial_no, id, buyer_name, ticket_category, status, issued_at, used_at
       FROM tickets ORDER BY serial_no`,
    (err, rows) => {
      if (err) return res.status(500).send('DB error');
      const header = 'serial_no,id,buyer_name,ticket_category,status,issued_at,used_at';
      const lines  = rows.map(r => [
        r.serial_no, r.id, r.buyer_name, r.ticket_category, r.status, r.issued_at, r.used_at
      ].map(csvEscape).join(','));
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition','attachment; filename="tickets.csv"');
      res.send([header, ...lines].join('\r\n'));
    }
  );
});

// ===== Публичные маршруты (без логина) =====


// ===== Очистка базы данных (только для админа) =====
app.post("/api/admin/clear", requireAuth, async (req, res) => {
  try {
    db.serialize(() => {
      db.run("DELETE FROM tickets");
      db.run("DELETE FROM ticket_numbers");
    });

    // Вставляем заново все 200 номеров
    db.serialize(() => {
      db.run(`
        WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<200)
        INSERT INTO ticket_numbers (number)
        SELECT x FROM seq;
      `);
    });

    res.json({ ok: true, message: "База успешно очищена и перезаполнена." });
  } catch (e) {
    console.error("Ошибка очистки:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// Скачать PDF (с ожиданием готовности)
app.get('/download/:id', async (req, res) => {
  const file = path.resolve(OUT_DIR, `${req.params.id}.pdf`);
  try {
    await waitForFile(file, 5000, 100);
    res.setHeader('Cache-Control', 'no-store');
    return res.download(file, `${req.params.id}.pdf`);
  } catch {
    return res.status(404).send('PDF ещё готовится, попробуйте скачать через секунду.');
  }
});

// Открыть PDF (с ожиданием готовности)
app.get('/view/:id', async (req, res) => {
  const file = path.resolve(OUT_DIR, `${req.params.id}.pdf`);
  try {
    await waitForFile(file, 5000, 100);
    res.setHeader('Cache-Control', 'no-store');
    res.type('pdf');
    return res.sendFile(file);
  } catch {
    return res.status(404).send('PDF ещё готовится, попробуйте открыть через секунду.');
  }
});

// Проверка билета + отметка used
app.post('/api/verify', (req, res) => {
  const raw = (req.body && (req.body.ticket_id || req.body.id || req.body.code || req.body.text)) || '';
  const text = String(raw).trim();
  const match = text.match(/[A-Z]{3}-\d{8}-[A-Z0-9]{8}/i);
  const ticket_id = match ? match[0].toUpperCase() : null;

  if (!ticket_id) {
    return res.status(400).json({ status: 'ERROR', error: 'ticket_id required' });
  }

  db.get(
    `SELECT id, buyer_name, status, used_at FROM tickets WHERE id = ?`,
    [ticket_id],
    (err, row) => {
      if (err)  return res.status(500).json({ status: 'ERROR', error: err.message });
      if (!row) return res.status(404).json({ status: 'INVALID' });

      if (row.status === 'used') {
        return res.status(200).json({
          status: 'ALREADY_USED',
          ticket_id: row.id,
          buyer_name: row.buyer_name,
          used_at: row.used_at,
        });
      }

      const usedAt = new Date().toISOString();
      db.run(
        `UPDATE tickets SET status='used', used_at=? WHERE id=? AND status!='used'`,
        [usedAt, ticket_id],
        function (uerr) {
          if (uerr) return res.status(500).json({ status: 'ERROR', error: uerr.message });
          if (this.changes === 0) {
            return res.status(200).json({
              status: 'ALREADY_USED',
              ticket_id: row.id,
              buyer_name: row.buyer_name,
              used_at: row.used_at,
            });
          }
          return res.status(200).json({
            status: 'OK',
            ticket_id: row.id,
            buyer_name: row.buyer_name,
            used_at: usedAt,
          });
        }
      );
    }
  );
});

// ===== Страницы админки/сканера (под паролем) =====
app.get('/admin',      requireAuth, (_req,res)=> res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/admin.html', requireAuth, (_req,res)=> res.redirect('/admin'));
app.get('/scan',       requireAuth, (_req,res)=> res.sendFile(path.join(__dirname,'public','scan.html')));
app.get('/scan.html',  requireAuth, (_req,res)=> res.redirect('/scan'));

// ===== Логин/логаут =====
app.get('/login', (_req,res)=> res.sendFile(path.join(__dirname,'public','login.html')));
app.post('/login', (req,res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.user = { u: username, ts: Date.now() };
    return res.redirect('/admin');
  }
  return res.redirect('/login?e=1');
});
app.post('/logout', (req,res) => { req.session = null; res.redirect('/login'); });

// ===== Статика (последней строкой) =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== Старт =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server: http://localhost:${PORT}`));