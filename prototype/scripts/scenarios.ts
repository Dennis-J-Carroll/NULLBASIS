// Prints every scripted playthrough tick by tick. Usage: npm run scenarios
import { SCENARIOS, trace } from '../src/scenarios.ts';
import { fmt, fmtV } from '../src/math.ts';

for (const sc of SCENARIOS) {
  const { state, log } = trace(sc);
  console.log(`\n## ${sc.name}  [${sc.level}]`);
  for (const events of log) {
    for (const e of events) {
      if (e.type === 'core') {
        const r = e.reading;
        console.log(`  t${r.tick}: core=${fmtV(r.y)} supply=${fmt(r.supply)} threat=${fmt(r.threat)} dmg=${fmt(r.damage)}${r.clean ? ' clean' : ''}`);
      } else if (e.type === 'ripple') {
        console.log(`  strike: g at Intake=${fmtV(e.steps[e.steps.length - 1].g)} leech -${fmt(e.leechDamage)} friendly -${fmt(e.friendlyDamage)}`);
      } else if (e.type === 'scan') console.log(`  scan N${e.node}: ${e.verdict}`);
      else if (e.type === 'saturated') console.log(`  N${e.node} saturated`);
    }
  }
  console.log(`  => ${state.status.toUpperCase()} at t${state.tick}, Core HP ${fmt(state.core.hp)}, N2 integrity ${state.nodes[2].integrity}, spent ${state.spent.bw} BW / ${state.spent.heat} Heat`);
}
