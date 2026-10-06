const db = require('better-sqlite3')(':memory:');
db.exec("CREATE TABLE f (b TEXT, status TEXT)");
db.exec("INSERT INTO f VALUES ('2026-10-01', 'pending_design')");
console.log(db.prepare("SELECT * FROM f WHERE b LIKE ? AND status = 'pending_design'").all('%-10-01'));
