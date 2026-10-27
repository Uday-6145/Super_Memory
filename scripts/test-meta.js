import { createModelProvider } from '../src/models/index.js';

console.log('Connecting to Meta...');

try {
  const provider = createModelProvider('meta');
  console.log(`Model: ${provider.modelId}`);

  const result = await provider.complete({
    messages: [
      {
        role: 'user',
        content: 'Respond with exactly: "Meta Muse connection successful!"',
      },
    ],
    maxTokens: 200,
  });

  if (result.isTruncated && !result.text) {
    console.warn('\n[Warning] Model response truncated due to token limit.');
  }

  console.log('\n[Success] Model responded:');
  console.log(result.text.trim() || '(Empty response content)');
} catch (error) {
  if (error.code === 'MISSING_API_KEY') {
    console.error('\n[Error] META_API_KEY is missing or empty.');
    console.error('Please configure your META_API_KEY in your local .env file:');
    console.error('  META_API_KEY=your_key_here\n');
  } else if (error.code === 'API_ERROR') {
    console.error(`\n[Failed] HTTP ${error.statusCode} (${error.statusText})`);
    if (error.responseBody) {
      console.error(`Provider message: ${error.responseBody}`);
    }
  } else {
    console.error('\n[Connection Error] Request failed:');
    console.error(error.message || 'Unknown network error');
  }
  process.exit(1);
}
