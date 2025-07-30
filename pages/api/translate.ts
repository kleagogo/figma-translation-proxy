import { NextApiRequest, NextApiResponse } from 'next';

// CORS headers to allow Figma plugin to access this endpoint
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      .end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, targetLanguage = 'German', useGlossary = false } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text to translate is required' });
    }

    // Get API keys from environment variables
    const LANGDOCK_API_KEY = process.env.LANGDOCK_API_KEY;
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    
    if (!LANGDOCK_API_KEY) {
      return res.status(500).json({ error: 'Translation service not configured' });
    }

    let finalTranslation = '';

    // Try glossary first if enabled and available
    if (useGlossary && AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
      try {
        const glossaryResult = await translateWithGlossary(text, targetLanguage, AIRTABLE_API_KEY, AIRTABLE_BASE_ID);
        if (glossaryResult.hasGlossaryTerms) {
          finalTranslation = glossaryResult.translatedText;
        }
      } catch (glossaryError) {
        console.warn('Glossary translation failed, falling back to AI:', glossaryError);
      }
    }

    // Use AI translation if no glossary result or glossary failed
    if (!finalTranslation) {
      finalTranslation = await translateWithAI(text, targetLanguage, LANGDOCK_API_KEY);
    }

    // Return the translation with CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    return res.status(200).json({ 
      success: true,
      originalText: text,
      translatedText: finalTranslation.trim(),
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

// AI Translation function (existing logic)
async function translateWithAI(text: string, targetLanguage: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.langdock.com/openai/eu/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
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
    throw new Error(`AI translation failed: ${response.status}`);
  }

  const data = await response.json();
  const translatedText = data.choices?.[0]?.message?.content;
  
  if (!translatedText) {
    throw new Error('No translation received from AI service');
  }

  return translatedText;
}

// Glossary Translation function (NEW!)
async function translateWithGlossary(
  text: string, 
  targetLanguage: string, 
  airtableApiKey: string, 
  baseId: string
): Promise<{translatedText: string, hasGlossaryTerms: boolean}> {
  
  // Map language names to table names
  const tableNames: {[key: string]: string} = {
    'German': 'German translations',
    'Spanish': 'Spanish translations', 
    'Dutch': 'Dutch translations',
    'Italian': 'Italian translations',
    'Polish': 'Polish translations',
    'Portuguese': 'Portuguese translations',
    'Swedish': 'Swedish translations',
    'Finnish': 'Finnish translations'
  };

  const tableName = tableNames[targetLanguage];
  if (!tableName) {
    throw new Error(`No glossary table found for language: ${targetLanguage}`);
  }

  // Fetch glossary from Airtable
  const airtableUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
  
  const response = await fetch(airtableUrl, {
    headers: {
      'Authorization': `Bearer ${airtableApiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Airtable API error: ${response.status}`);
  }

  const data = await response.json();
  const glossaryEntries = data.records || [];

  // Create translation map
  const glossaryMap: {[key: string]: string} = {};
  for (const record of glossaryEntries) {
    const englishSource = record.fields['English source'];
    const translation = record.fields[`${targetLanguage} translation`];
    
    if (englishSource && translation) {
      glossaryMap[englishSource.toLowerCase()] = translation;
    }
  }

  // Apply glossary translations
  let translatedText = text;
  let hasReplacements = false;

  // Sort by length (longer phrases first) to avoid partial replacements
  const sortedTerms = Object.keys(glossaryMap).sort((a, b) => b.length - a.length);
  
  for (const englishTerm of sortedTerms) {
    const translation = glossaryMap[englishTerm];
    // Case-insensitive replacement
    const regex = new RegExp(`\\b${englishTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (regex.test(translatedText)) {
      translatedText = translatedText.replace(regex, translation);
      hasReplacements = true;
    }
  }

  return {
    translatedText,
    hasGlossaryTerms: hasReplacements
  };
}
