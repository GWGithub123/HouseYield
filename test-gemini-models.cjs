require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.Gemini_API_Key || process.env.GEMINI_API_KEY);

async function testModel(modelName, config = {}) {
  try {
    const model = genAI.getGenerativeModel({ model: modelName, ...config });
    const result = await model.generateContent('Say hi');
    console.log('✓', modelName, '- works');
    return true;
  } catch (e) {
    console.log('✗', modelName, '-', e.message.substring(0, 100));
    return false;
  }
}

async function main() {
  console.log('Testing Gemini models...');
  console.log('API Key present:', !!process.env.GEMINI_API_KEY);
  console.log('');
  
  // Test various model names
  await testModel('gemini-2.5-flash');
  await testModel('gemini-2.5-pro');
  await testModel('gemini-2.5-flash-image');
  await testModel('gemini-3-pro-image-preview');
  
  console.log('\nDone!');
}

main().catch(console.error);
