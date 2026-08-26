require('dotenv').config();
const Replicate = require('replicate');
const r = new Replicate({auth: process.env.REPLICATE_API_KEY});

(async () => {
  const m = await r.models.get('cjwbw', 'zoedepth');
  const v = m.latest_version;
  const schema = v.openapi_schema;
  const modelType = schema?.components?.schemas?.model_type;
  console.log('model_type enum:', JSON.stringify(modelType, null, 2));
  console.log('\nVersion ID:', v.id);
  console.log('Full input schema:', JSON.stringify(schema?.components?.schemas?.Input, null, 2));
})();
