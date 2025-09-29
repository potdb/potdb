import request from 'supertest';

// We need to set token env before importing the app module because auth loads tokens once at import time.
describe('authentication middleware', () => {
  const path = require('path');
  const fs = require('fs');
  const tmpDir = path.join(process.cwd(), 'tmp-auth');

  beforeAll(() => {
    jest.resetModules();
    process.env.POTDB_TOKEN = 'test-token';
    process.env.POTDB_DATA_DIR = tmpDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getApp() {
    jest.resetModules();
    process.env.POTDB_TOKEN = 'test-token';
    process.env.POTDB_DATA_DIR = tmpDir;
    return import('../../src/index');
  }

  test('rejects unauthorized requests with 401', async () => {
    const { createApp } = await getApp();
    const app = createApp();
    await request(app).get('/health').expect(401);
  });

  test('accepts authorized requests with valid bearer token', async () => {
    const { createApp } = await getApp();
    const app = createApp();
    await request(app).get('/health').set('Authorization', 'Bearer test-token').expect(200);
  });

  test('protects API endpoints', async () => {
    const { createApp } = await getApp();
    const app = createApp();

    // Unauthorized should be rejected
    await request(app).get('/api/docs').expect(401);

    // Authorized should succeed
    const res = await request(app)
      .get('/api/docs')
      .set('Authorization', 'Bearer test-token')
      .expect(200);
    expect(Array.isArray(res.body.ids)).toBe(true);
  });
});
