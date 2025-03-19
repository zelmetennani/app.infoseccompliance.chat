// Netlify function to proxy requests to Anthropic Claude API
exports.handler = async function(event, context) {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
      headers: {
        'Allow': 'POST'
      }
    };
  }

  try {
    // Parse the request body
    const requestBody = JSON.parse(event.body);
    const userMessage = requestBody.message;

    if (!userMessage) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Message is required' })
      };
    }

    // Get the API key from environment variables
    const apiKey = process.env.VITE_LLM_API_KEY;
    if (!apiKey) {
      console.error('Claude API key not found in environment variables');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'API configuration error' })
      };
    }

    // Call the Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: userMessage
          }
        ]
      })
    });

    // Handle API errors
    if (!response.ok) {
      const errorData = await response.json();
      console.error('Anthropic API error:', errorData);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: 'Error from Claude API', details: errorData })
      };
    }

    // Return the successful response
    const data = await response.json();
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: data.content[0].text 
      })
    };

  } catch (error) {
    console.error('Error in Claude proxy function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error', message: error.message })
    };
  }
};