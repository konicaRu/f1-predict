const { fetchJolpica, q, close } = require('./lib');
const { deadlineUtc } = require('./deadlines');
const TEAMS = require('./teams');

// driverId -> {constructorId, name} из driverStandings (кто уже ехал)
async function driverTeams(){
  const d = await fetchJolpica('2026/driverStandings');
  const lists = d.MRData.StandingsTable.StandingsLists;
  const map = {};
  if(lists && lists[0]){
    for(const s of lists[0].DriverStandings){
      const c = s.Constructors[s.Constructors.length-1];
      map[s.Driver.driverId] = { constructorId:c.constructorId, name:c.name };
    }
  }
  return map;
}

async function importDrivers(){
  const d = await fetchJolpica('2026/drivers');
  const teams = await driverTeams();
  let n=0, gray=0, skipped=0;
  for(const dr of d.MRData.DriverTable.Drivers){
    if(!dr.code){ skipped++; continue; }   // резервисты без 3-буквенного кода — не в гриде, схема требует code NOT NULL
    const t = teams[dr.driverId];
    const color = t ? (TEAMS[t.constructorId] || '#888') : null;
    if(t && !TEAMS[t.constructorId]){ gray++; console.warn('нет цвета для команды', t.constructorId); }
    await q(
      `insert into drivers(id,code,name,team,team_color,active) values($1,$2,$3,$4,$5,true)
       on conflict (id) do update set code=excluded.code, name=excluded.name,
         team=excluded.team, team_color=excluded.team_color, active=excluded.active`,
      [dr.driverId, dr.code, `${dr.givenName} ${dr.familyName}`, t?t.name:null, color]
    );
    n++;
  }
  console.log(`drivers: ${n} upsert (${gray} без цвета, ${skipped} без кода пропущено)`);
}

async function main(){
  const cmd = process.argv[2];
  if(cmd==='drivers') await importDrivers();
  else { console.error('usage: drivers|calendar|results|all'); process.exit(2); }
  await close();
}
main().catch(async e=>{ console.error('ERR', e.code||'', e.message); await close(); process.exit(1); });
