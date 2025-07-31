import { NextApiRequest, NextApiResponse } from 'next';

// CORS headers to allow Figma plugin to access this endpoint
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('🚀 TRANSLATION API CALLED!', new Date().toISOString());
  
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

    console.log('📝 Request params:', { text, targetLanguage, useGlossary });

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
      console.log('💫 Trying glossary translation...');
      try {
        const glossaryResult = await translateWithGlossary(text, targetLanguage, AIRTABLE_API_KEY, AIRTABLE_BASE_ID);
        if (glossaryResult.hasGlossaryTerms) {
          finalTranslation = glossaryResult.translatedText;
          console.log('✅ Using glossary result:', finalTranslation);
        } else {
          console.log('⚠️ No glossary matches, falling back to AI');
        }
      } catch (glossaryError) {
        console.warn('❌ Glossary translation failed, falling back to AI:', glossaryError);
      }
    }

    // Fall back to AI translation if glossary didn't work
    if (!finalTranslation) {
      console.log('🤖 Using AI translation...');
      finalTranslation = await translateWithLangdock(text, targetLanguage, LANGDOCK_API_KEY);
    }

    // Return the translation with CORS headers
    return res.status(200).json({
      translatedText: finalTranslation,
      originalText: text,
      targetLanguage: targetLanguage
    });

  } catch (error: any) {
    console.error('Translation error:', error);
    return res.status(500).json({ 
      error: 'Translation failed', 
      details: error.message 
    });
  }
}

// AI Translation function using Langdock
async function translateWithLangdock(text: string, targetLanguage: string, apiKey: string): Promise<string> {
  const response = await fetch('https://api.langdock.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: `Translate the following English text to ${targetLanguage}: "${text}"`
        }
      ],
      max_tokens: 150,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`Langdock API error: ${response.status}`);
  }

  const data = await response.json();
  let translatedText = data.choices[0]?.message?.content?.trim() || text;

  // Clean up quotes if present
  if (translatedText.startsWith('"') && translatedText.endsWith('"')) {
    translatedText = translatedText.slice(1, -1);
  }
  if (translatedText.startsWith("'") && translatedText.endsWith("'")) {
    translatedText = translatedText.slice(1, -1);
  }

  return translatedText.trim();
}

// IMPROVED Glossary Translation function
async function translateWithGlossary(
  text: string, 
  targetLanguage: string, 
  airtableApiKey: string, 
  baseId: string
): Promise<{translatedText: string, hasGlossaryTerms: boolean}> {
  
  console.log(`🔍 Starting glossary lookup for "${text}" in ${targetLanguage}`);
  
  // Map language names to table names (try multiple variations)
  const tableNames: {[key: string]: string[]} = {
    'German': ['German translations', 'German', 'DE', 'Deutsch'],
    'Spanish': ['Spanish translations', 'Spanish', 'ES', 'Español'], 
    'Dutch': ['Dutch translations', 'Dutch', 'NL', 'Nederlands'],
    'Italian': ['Italian translations', 'Italian', 'IT', 'Italiano'],
    'Polish': ['Polish translations', 'Polish', 'PL', 'Polski'],
    'Portuguese': ['Portuguese translations', 'Portuguese', 'PT', 'Português'],
    'Swedish': ['Swedish translations', 'Swedish', 'SV', 'Svenska'],
    'Finnish': ['Finnish translations', 'Finnish', 'FI', 'Suomi']
  };

  const possibleTableNames = tableNames[targetLanguage] || [targetLanguage];
  
  let glossaryData = null;
  let usedTableName = '';

  // Try different table names
  for (const tableName of possibleTableNames) {
    try {
      console.log(`📋 Trying table: "${tableName}"`);
      const airtableUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
      
      const response = await fetch(airtableUrl, {
        headers: {
          'Authorization': `Bearer ${airtableApiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        glossaryData = await response.json();
        usedTableName = tableName;
        console.log(`✅ Found table: "${tableName}" with ${glossaryData.records?.length || 0} records`);
        break;
      } else {
        console.log(`❌ Table "${tableName}" not found (${response.status})`);
      }
    } catch (error: any) {
      console.log(`❌ Error accessing table "${tableName}":`, error.message);
    }
  }

  if (!glossaryData) {
    throw new Error(`No glossary table found for language: ${targetLanguage}`);
  }

  const glossaryEntries = glossaryData.records || [];
  console.log(`📚 Processing ${glossaryEntries.length} glossary entries`);

  // Create translation map with flexible column names
  const glossaryMap: {[key: string]: string} = {};
  
  for (const record of glossaryEntries) {
    const fields = record.fields;
    
    // Try different column name variations for English source
    let englishSource = '';
    const englishColumns = ['English source', 'English', 'EN', 'Source', 'english', 'english source'];
    for (const col of englishColumns) {
      if (fields[col]) {
        englishSource = fields[col];
        break;
      }
    }
    
    // Try different column name variations for translation
    let translation = '';
    const translationColumns = [
      `${targetLanguage} translation`,
      `${targetLanguage}`,
      targetLanguage.toLowerCase(),
      targetLanguage.toLowerCase() + ' translation',
      'Translation',
      'translation'
    ];
    
    for (const col of translationColumns) {
      if (fields[col]) {
        translation = fields[col];
        break;
      }
    }
    
    if (englishSource && translation) {
      const key = englishSource.toLowerCase().trim();
      glossaryMap[key] = translation.trim();
      console.log(`📖 Added: "${englishSource}" → "${translation}"`);
    }
  }
  
  console.log(`📊 Loaded ${Object.keys(glossaryMap).length} terms from table "${usedTableName}"`);
  
  if (Object.keys(glossaryMap).length === 0) {
    console.log('⚠️ No valid translations found in glossary');
    return { translatedText: text, hasGlossaryTerms: false };
  }

  // Apply glossary translations with improved matching
  let translatedText = text;
  let hasReplacements = false;

  // Sort by length (longer phrases first) to avoid partial replacements
  const sortedTerms = Object.keys(glossaryMap).sort((a, b) => b.length - a.length);
  
  console.log(`🔍 Searching for matches in: "${text.toLowerCase()}"`);
  
  for (const englishTerm of sortedTerms) {
    const translation = glossaryMap[englishTerm];
    
    // Multiple matching strategies
    const textLower = translatedText.toLowerCase();
    const termLower = englishTerm.toLowerCase();
    
    // Exact match (case insensitive)
    if (textLower === termLower) {
      console.log(`🎯 EXACT MATCH: "${englishTerm}" → "${translation}"`);
      translatedText = translation;
      hasReplacements = true;
      break;
    }
    
    // Word boundary match
    const regex = new RegExp(`\\b${englishTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (regex.test(translatedText)) {
      console.log(`🎯 WORD MATCH: "${englishTerm}" → "${translation}"`);
      translatedText = translatedText.replace(regex, translation);
      hasReplacements = true;
    }
    
    // Partial match (contains)
    else if (textLower.includes(termLower)) {
      console.log(`🎯 PARTIAL MATCH: "${englishTerm}" → "${translation}"`);
      // Only replace if it's a significant portion of the text
      if (englishTerm.length >= text.length * 0.5) {
        translatedText = translation;
        hasReplacements = true;
        break;
      }
    }
  }
  
  console.log(`🏁 Final result: hasReplacements=${hasReplacements}, result="${translatedText}"`);

  return {
    translatedText,
    hasGlossaryTerms: hasReplacements
  };
}
