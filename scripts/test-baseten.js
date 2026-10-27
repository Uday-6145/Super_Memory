const apiKey = process.env.BASETEN_API_KEY;
const baseUrl = process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1';
const modelId = process.env.BASETEN_MODEL_ID || 'meta-models/muse-spark-open-1026';

if (!apiKey || apiKey.trim() === '') {
  console.error('\n[Error] BASETEN_API_KEY is missing or empty.');
  console.error('Please create a .env file and set your API key:');
  console.error('  BASETEN_API_KEY=your_key_here\n');
  process.exit(1);
}

const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

console.log('Connecting to Baseten...');
console.log(`Model: ${modelId}`);

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: 'user',
          content: 'Respond with exactly: "Baseten Muse Spark connection successful!"',
        },
      ],
      max_tokens: 200,
    }),
  });

  if (!response.ok) {
    const status = response.status;
    const statusText = response.statusText;
    let errorDetail = '';

    try {
      const errJson = await response.json();
      errorDetail = errJson?.error?.message || errJson?.message || '';
    } catch {
      errorDetail = '';
    }

    console.error(`\n[Failed] HTTP ${status} (${statusText})`);
    if (errorDetail) {
      console.error(`Provider message: ${errorDetail}`);
    }
    process.exit(1);
  }

  const data = await response.json();
  const choice = data?.choices?.[0];
  const message = choice?.message;

  let reply = '';
  if (typeof message?.content === 'string') {
    reply = message.content.trim();
  } else if (Array.isArray(message?.content)) {
    reply = message.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }

  if (!reply && choice?.finish_reason === 'length') {
    console.warn('\n[Warning] Model response truncated due to token limit during reasoning.');
  }

  console.log('\n[Success] Model responded:');
  console.log(reply || '(Empty response content)');
} catch (error) {
  console.error('\n[Connection Error] Request failed:');
  console.error(error.message || 'Unknown network error');
  process.exit(1);
}
