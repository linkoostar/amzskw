// seed demo data for UI smoke test (not shipped; dev only)
import Database from 'better-sqlite3';

const db = new Database(process.argv[2] || 'data/amz.db');
const now = () => new Date().toISOString();

const insKw = db.prepare('INSERT INTO keywords(text, mid, alias, note) VALUES (?,?,?,?)');
const kwId1 = insKw.run('starlink mini', 'ATVPDKIKX0DER', 'aps', '演示').lastInsertRowid;
const kwId2 = insKw.run('portable power station', 'A1F83G8C2ARO7P', 'aps', '').lastInsertRowid;

const insRun = db.prepare('INSERT INTO runs(trigger_type,status,total_keywords,done_keywords,total_requests,error_requests,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?)');
const insItem = db.prepare('INSERT INTO run_items(run_id,keyword_id,keyword_text,mid,status,basic_count,expand_count,request_count,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insRaw = db.prepare('INSERT INTO suggestions_raw(run_item_id,keyword_id,mid,phrase,phrase_norm,source_type,parent_phrase,letter,position,strategy_id,sugg_type,raw_json,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insLex = db.prepare('INSERT OR IGNORE INTO lexicon(mid,phrase_norm,phrase,first_seen_at,first_seen_keyword_id,last_seen_at,seen_count) VALUES (?,?,?,?,?,?,?)');

const weeks = 3;
for (let w = 0; w < weeks; w++) {
  const at = new Date(Date.now() - (weeks - 1 - w) * 7 * 86400_000).toISOString();
  for (const kwId of [kwId1, kwId2]) {
    const kw = db.prepare('SELECT text, mid FROM keywords WHERE id=?').get(kwId);
    const runId = insRun.run('weekly', 'done', 2, 2, 3, 0, at, at).lastInsertRowid;
    const itemId = insItem.run(runId, kwId, kw.text, kw.mid, 'done', 3, 2, 3, at, at).lastInsertRowid;
    const basics = w === weeks - 1
      ? ['starlink mini charger', 'starlink mini mount', 'starlink mini case']
      : ['starlink mini mount', 'starlink mini case', 'starlink mini charger'];
    basics.forEach((p, i) => {
      insRaw.run(itemId, kwId, kw.mid, p, p.toLowerCase(), 'basic', null, null, i + 1, 'organic', 'KEYWORD', '{}', at);
      insLex.run(kw.mid, p.toLowerCase(), p, at, kwId, at, 1);
    });
    const ex = [['starlink mini mount', 'a', 'starlink mini mount adapter'], ['starlink mini case', 'b', 'starlink mini case waterproof']];
    ex.forEach(([parent, letter, phrase], i) => {
      insRaw.run(itemId, kwId, kw.mid, phrase, phrase.toLowerCase(), 'expand', parent, letter, i + 1, 'organic', 'KEYWORD', '{}', at);
      insLex.run(kw.mid, phrase.toLowerCase(), phrase, at, kwId, at, 1);
    });
  }
}

const apiKeyHash = 'd3adb33f' + '0'.repeat(56); // demo only
db.prepare('INSERT OR IGNORE INTO api_keys(name,key_prefix,key_hash,credits_balance,last_used_at) VALUES (?,?,?,?,?)')
  .run('demo-agent', 'ak_demo000000', apiKeyHash, 970, now());
const insLedger = db.prepare('INSERT INTO credits_ledger(api_key_id,delta,balance_after,reason,detail) VALUES (?,?,?,?,?)');
insLedger.run(1, 1000, 1000, 'bonus', 'initial');
insLedger.run(1, -10, 990, 'tool_call', 'search_suggestions');
insLedger.run(1, -20, 970, 'tool_call', 'get_keyword_trends');
console.log('seeded OK');
