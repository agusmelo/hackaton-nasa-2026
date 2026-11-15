// Patches the vendored Aladin Lite so the "What is this?" context-menu entry asks the Harvard
// SIMBAD mirror first and only falls back to the CDS quick-SIMBAD service if Harvard fails.
// (The CDS service has been answering 404, which also made the popup link to a dead page.)
// Run on a pristine copy of the library: node patch_aladin.js aladin.js
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

// Returns the nearest SIMBAD object in the "coo/name(mag,type)" text format of the CDS quick service.
const harvard =
  'B.HOST="simbad.harvard.edu",' +
  'B.harvard=function(A,I,C){' +
  'const q="SELECT TOP 1 main_id, ra, dec, description, V, DISTANCE(POINT(\'ICRS\',ra,dec),POINT(\'ICRS\',"+A+","+I+")) AS d ' +
  'FROM basic JOIN otypedef USING(otype) LEFT JOIN allfluxes ON oid=oidref ' +
  'WHERE CONTAINS(POINT(\'ICRS\',ra,dec),CIRCLE(\'ICRS\',"+A+","+I+","+C+"))=1 ORDER BY d";' +
  'return fetch("https://simbad.harvard.edu/simbad/sim-tap/sync?"+new URLSearchParams({request:"doQuery",lang:"adql",format:"json",query:q}),{signal:AbortSignal.timeout(15e3)})' +
  '.then(r=>{if(!r.ok)throw r.status;return r.json()})' +
  '.then(j=>{B.HOST="simbad.harvard.edu";const r=j.data&&j.data[0];' +
  'return r?r[1]+" "+(r[2]<0?"":"+")+r[2]+"/"+r[0]+"("+(r[4]==null?"":r[4])+","+String(r[3]).replace(/[()]/g,"")+")":""})},';

const cdsQuery = 'Y.loadFromUrls(B.MIRRORS,{contentType:"text/plain",data:E,dataType:"text"})';
const edits = [
  [
    'B.query=function(A,I,C,g){var Q=new oA(A,I,7),E={Ident:Q.format("s/"),SR:C};' + cdsQuery + '.then(o=>{var i=',
    harvard +
      'B.query=function(A,I,C,g){var Q=new oA(A,I,7),E={Ident:Q.format("s/"),SR:C};' +
      'B.harvard(A,I,C).catch(()=>' + cdsQuery +
      // a CDS server that is down can answer with an HTML error page
      '.then(o=>{if(typeof o=="string"&&/^\\s*</.test(o))throw 0;return B.HOST="simbad.cds.unistra.fr",o}))' +
      '.then(o=>{var i=',
  ],
  [
    'href="https://simbad.cds.unistra.fr/simbad/sim-id?Ident=\'+encodeURIComponent(c)',
    'href="https://\'+B.HOST+\'/simbad/sim-id?Ident=\'+encodeURIComponent(c)',
  ],
  [
    'No match was found on <a href="https://simbad.cds.unistra.fr/simbad">Simbad</a>',
    'No match was found on <a target="_blank" href="https://\'+B.HOST+\'/simbad/">Simbad</a>',
  ],
];
for (const [from, to] of edits) {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`expected exactly 1 match, found ${n}: ${from.slice(0, 70)}`);
  src = src.replace(from, () => to);
}
fs.writeFileSync(file, src);
console.log("patched", file);
