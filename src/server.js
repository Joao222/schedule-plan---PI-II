const app = require('./app');
const { seed } = require('./seed');

if (process.env.SEED_DEMO !== 'false' && seed()) {
  console.log('Banco vazio: dados de demonstração criados (admin@empresa.com / Admin@123, operador@empresa.com / Operador@123).');
}

const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, () => console.log(`Agenda & Escalas rodando em http://localhost:${PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
