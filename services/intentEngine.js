const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize the Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// We use Gemini 2.5 Flash because it is incredibly fast and cheap for structured JSON tasks
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

/**
 * Analyzes raw GSC data to find Keyword Cannibalization using Intent Clustering
 * @param {Array} gscData - Array of objects containing { query, url, clicks, impressions }
 */
async function clusterKeywordsByIntent(gscData) {
    try {
        const prompt = `
        You are an expert Enterprise SEO Analyst. Your job is to analyze Google Search Console data and identify "Keyword Cannibalization" via Search Intent Clustering.
        
        Cannibalization happens when multiple different URLs from the same website are ranking for keywords that share the EXACT SAME search intent. 
        
        Analyze the following JSON data. Group the URLs into "Intent Clusters". 
        For each cluster that has MORE THAN ONE unique URL, you must determine the "Winner" and the "Loser(s)".
        - The Winner (Canonical): The URL with the most total clicks and impressions for that intent.
        - The Loser(s) (Cannibal): The weaker URL(s) that should be 301 redirected to the Winner.

        Return ONLY a raw, minified JSON array of objects. Do not use markdown blocks. Do not include any conversational text.
        
        Schema Requirement:
        [
          {
            "intent_name": "Short name for the search intent (e.g., Fleet Software Pricing)",
            "total_search_volume": <sum of impressions>,
            "winning_url": "The strongest URL",
            "losing_urls": ["url1", "url2"],
            "recommended_action": "Resolve via 301 Redirect"
          }
        ]

        Here is the raw GSC data to analyze:
        ${JSON.stringify(gscData)}
        `;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        // Strip markdown formatting if Gemini accidentally includes it
        const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

        return JSON.parse(cleanJson);

    } catch (error) {
        console.error("❌ Gemini API Error:", error);
        throw new Error("Failed to process data with Gemini.");
    }
}

module.exports = { clusterKeywordsByIntent };