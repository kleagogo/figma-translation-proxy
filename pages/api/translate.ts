import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200)
      .setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      .end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, targetLanguage = 'German' } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text to translate is required' });
    }

    // Get Langdock API key from environment variables
    const LANGDOCK_API_KEY = process.env.LANGDOCK_API_KEY;
    
    if (!LANGDOCK_API_KEY) {
      return res.status(500).json({ error: 'Translation service not configured' });
    }

    // Call Langdock API
    const response = await fetch('https://api.langdock.com/openai/eu/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LANGDOCK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a professional translator. Translate the given English text to ${targetLanguage}. Return only the ${targetLanguage} translation, no explanations or additional text.`
          },
          {
            role: 'user',
            content: `Translate this English text to ${targetLanguage}: "${text}"`
          }
        ],
        max_tokens: 1000,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      console.error('Langdock API error:', response.status, response.statusText);
      return res.status(response.status).json({ 
        error: `Translation service error: ${response.status}` 
      });
    }

    const data = await response.json();
    const translatedText = data.choices?.[0]?.message?.content;
    
    if (!translatedText) {
      return res.status(500).json({ error: 'No translation received from service' });
    }

    // Return the translation with CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    return res.status(200).json({ 
      success: true,
      originalText: text,
      translatedText: translatedText.trim(),
      targetLanguage 
    });

  } catch (error: any) {
    console.error('Translation proxy error:', error);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ 
      error: 'Translation failed', 
      details: error.message 
    });
  }
}
