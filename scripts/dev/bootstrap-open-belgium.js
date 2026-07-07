// bootstrap-open-belgium.js — разовый dev-скрипт: открыть Бельгию (round 10) в проде.
// Cloud-direct через SUPABASE_DB_URL (прямое подключение обходит RLS, auth.uid() null -> гейт open_race пропускает).
// Запуск: cd scripts/dev && node bootstrap-open-belgium.js
const fs=require('fs'),path=require('path');const{Client}=require('pg');
const env=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');
const connStr=env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
(async()=>{
  const c=new Client({connectionString:connStr,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:20000,keepAlive:true});
  c.on('error',()=>{});
  await c.connect();
  try{
    const { rows:[r] } = await c.query('select id, status from races where season=2026 and round=10');
    if(!r){ console.error('гонка season=2026 round=10 не найдена'); process.exit(1); }
    const { rows:[p] } = await c.query('select public.open_race($1) as pool',[r.id]);
    console.log(`open_race(id=${r.id}, было status=${r.status}) OK — пул: ${p.pool} пилотов`);
  } finally { try{ await c.end(); }catch(_){} }
})().catch(e=>{ console.error('ERR', e.message); process.exit(1); });
