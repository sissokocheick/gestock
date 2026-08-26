const http = require('http');

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: { 'Content-Type': 'application/json', ...headers }
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const results = [];
  const test = async (name, fn) => {
    try {
      const r = await fn();
      const ok = r && r.status >= 200 && r.status < 300;
      results.push({ name, ok, status: r ? r.status : 'N/A' });
      console.log(`${ok ? '✅' : '❌'} ${name} [${r ? r.status : 'ERR'}]`);
    } catch (e) {
      results.push({ name, ok: false, status: 'ERR' });
      console.log(`❌ ${name} [${e.message}]`);
    }
  };

  // 1. Login
  let token = '';
  await test('Login admin', async () => {
    const r = await req('POST', 'http://localhost:4000/api/auth/login', { nom: 'admin', mdp: 'admin123' });
    if (r.status === 200) token = JSON.parse(r.data).token;
    return r;
  });

  const h = { Authorization: 'Bearer ' + token };
  const api = (method, path, body) => req(method, 'http://localhost:4000' + path, body, h);

  // 2-21. GET APIs
  const gets = [
    '/api/produits?limit=3',
    '/api/clients?limit=3',
    '/api/depenses?limit=3',
    '/api/ventes',
    '/api/rapports?jours=7',
    '/api/caisse',
    '/api/credits',
    '/api/familles',
    '/api/boutique',
    '/api/parametres',
    '/api/roles',
    '/api/droits',
    '/api/lots?limit=3',
    '/api/fournisseurs',
    '/api/péremptions',
    '/api/mouvements?limit=3',
    '/api/modes-paiement',
    '/api/validations',
    '/api/users',
    '/api/backups',
    '/api/dashboard/alertes',
    '/api/point/classement?from=2026-01-01&to=2026-12-31&par=caissiere',
  ];

  for (const path of gets) {
    const short = path.split('?')[0].replace('/api/', '');
    await test('GET ' + short, () => api('GET', path));
  }

  // Backup create
  await test('POST backup/create', () => api('POST', '/api/backups/create'));

  // Backup restore by name
  let backups = [];
  await test('GET backups list', async () => {
    const r = await api('GET', '/api/backups');
    backups = JSON.parse(r.data);
    return r;
  });

  if (backups.length > 0) {
    await test('POST backup/restore by name', () =>
      api('POST', '/api/backups/' + encodeURIComponent(backups[0].name) + '/restore'));
  }

  // Summary
  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`\n=== RÉSULTAT: ${ok}/${results.length} OK, ${fail} erreurs ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
