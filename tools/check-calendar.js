// One-off verification for the calendar feature (safe to delete).
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((js, i) => { new (require('vm').Script)(js); });
console.log('syntax OK (' + scripts.length + ' script blocks)');

let fail = 0;
['calPrevBtn', 'calNextBtn', 'calTodayBtn', 'calGrid', 'calMonthLabel', 'dayPop']
  .forEach(id => { if (!html.includes('id="' + id + '"')) { console.log('MISSING HTML ID: ' + id); fail = 1; } });

const allJs = scripts.join('\n');
['renderCalendar', 'showDayPop', 'closeDayPop', 'calGoTo', 'loadFestivals', 'festsOn', 'setView']
  .forEach(fn => { if (!allJs.includes('function ' + fn + '(')) { console.log('MISSING JS FN: ' + fn); fail = 1; } });

const fest = JSON.parse(fs.readFileSync('festivals.json', 'utf8'));
const years = Object.keys(fest.years);
console.log('festivals.json years:', years.join(', '),
  '· entries:', years.map(y => fest.years[y].length).join('/'));
if (!years.includes('2026') || !years.includes('2027')) { console.log('MISSING YEAR in festivals.json'); fail = 1; }

// Serve check: every referenced local asset must exist on disk.
['festivals.json', 'manifest.json', 'sw.js', 'icons/icon-192.png', 'icons/icon-512.png']
  .forEach(f => { if (!fs.existsSync(f)) { console.log('MISSING FILE: ' + f); fail = 1; } });

console.log(fail ? 'FAILURES found' : 'all calendar checks passed ✓');
process.exit(fail);
