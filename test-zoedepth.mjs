import 'dotenv/config';
import Replicate from 'replicate';
const r = new Replicate({auth: process.env.REPLICATE_API_KEY});

// ZoeDepth with ZoeD_N (metric indoor mode)
console.log('Running ZoeDepth ZoeD_N on test image...');
const output = await r.run(
  'cjwbw/zoedepth:6375723d97400d3ac7b88e3022b738bf6f433ae165c4a2acd1955eaa6b8fcb62',
  {
    input: {
      image: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=640',
      model_type: 'ZoeD_N'
    }
  }
);

console.log('Output type:', typeof output);
if (typeof output === 'object' && output !== null) {
  console.log('Output keys:', Object.keys(output));
  for (const [k, v] of Object.entries(output)) {
    console.log(`  ${k}:`, typeof v === 'string' ? v.substring(0, 120) : v);
  }
} else if (typeof output === 'string') {
  console.log('Output URL:', output.substring(0, 150));
}
