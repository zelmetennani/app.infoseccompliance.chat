// Initialize Firestore
let db;
let currentUser;
let currentConversationId = null;

// Define constants for tier limits
const FREE_TIER_LIMIT = 5; // 5 messages per day for free tier

// Function to initialize Firebase and Firestore
function initializeFirebase() {
  // Check if Firebase config exists and is not already initialized
  if (typeof firebaseConfig !== 'undefined' && !firebase.apps.length) {
    // Initialize Firebase with the config
    firebase.initializeApp(firebaseConfig);
    console.log("Firebase initialized from chat.js");
  } else if (!firebase.apps.length) {
    console.error("Firebase config not found and Firebase not initialized");
    return false;
  }
  
  // Initialize Firestore
  db = firebase.firestore();
  return true;
}

// Main initialization function
function initializeChat() {
  console.log("Initializing chat functionality");
  
  // Try to initialize Firebase
  if (!initializeFirebase()) {
    console.error("Failed to initialize Firebase. Chat functionality disabled.");
    return;
  }
  
  // Set up event listeners
  setupEventListeners();
  
  // Make sure DOM is fully loaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeAfterDOMLoaded);
  } else {
    initializeAfterDOMLoaded();
  }
}

// Initialize after DOM is loaded
function initializeAfterDOMLoaded() {
  // Extract token from cookies
  const cookies = document.cookie.split(';');
  let idToken = null;
  
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i].trim();
    if (cookie.startsWith('firebaseIdToken=')) {
      idToken = cookie.substring('firebaseIdToken='.length);
      break;
    }
  }
  
  if (idToken) {
    try {
      const tokenParts = idToken.split('.');
      if (tokenParts.length === 3) {
        const payload = JSON.parse(atob(tokenParts[1]));
        const userId = payload.user_id;
        
        // Store user information
        currentUser = {
          uid: userId,
          getIdToken: () => Promise.resolve(idToken)
        };
        
        // Ensure user document exists first
        createUserDocumentViaREST(userId, idToken)
          .then(() => {
            // After ensuring user document exists, load conversations
            return fetchFirestoreData(userId, idToken);
          })
          .then(conversations => {
            // Check if conversation list element exists before trying to use it
            const conversationListElement = document.getElementById('conversationList');
            if (conversationListElement) {
              displayConversationsList(conversations);
            }
            
            // Display welcome message
            if (!currentConversationId) {
              displayMessage("Hello! I'm your InfoSec Compliance Assistant. How can I help you today?", 'assistant');
            }
          })
          .catch(error => {
            console.error("Error initializing user data");
            
            // Display welcome message even if data loading failed
            if (!currentConversationId) {
              displayMessage("Hello! I'm your InfoSec Compliance Assistant. How can I help you today?", 'assistant');
            }
          });
      }
    } catch (e) {
      console.error("Error processing token");
    }
  }
}

// Call initialization when the document is loaded
document.addEventListener('DOMContentLoaded', initializeChat);

// Set up event listeners for UI components
function setupEventListeners() {
  // Chat form submission
  const chatForm = document.getElementById('chatForm');
  if (chatForm) {
    chatForm.addEventListener('submit', handleChatSubmit);
  }
  
  // New chat button
  const newChatBtn = document.getElementById('newChatBtn');
  if (newChatBtn) {
    newChatBtn.addEventListener('click', startNewChat);
  }
}

// Handle chat form submission
async function handleChatSubmit(event) {
  event.preventDefault();
  
  const messageInput = document.getElementById('messageInput');
  const message = messageInput.value.trim();
  
  if (!message) return;
  
  // Clear input field
  messageInput.value = '';
  
  try {
    // Check for user
    if (!currentUser) {
      displayErrorMessage("Authentication issue. Please try refreshing the page.");
      return;
    }
    
    // Display user message
    displayMessage(message, 'user');
    
    // Show typing indicator
    showTypingIndicator();
    
    try {
      // Ensure user document exists
      await initializeUser(currentUser);
      
      // Check user limits
      const canSend = await checkUserLimits(currentUser.uid, await currentUser.getIdToken());
      
      if (!canSend.allowed) {
        // User has reached their limit
        hideTypingIndicator();
        showUpgradePrompt(canSend.reason);
        return;
      }
      
      // Get conversation history for context if we have a current conversation
      let messageContext = [];
      if (currentConversationId) {
        const conversation = await getConversationViaREST(
          currentUser.uid, 
          currentConversationId, 
          await currentUser.getIdToken()
        );
        
        if (conversation && conversation.messages) {
          messageContext = conversation.messages;
        }
      }
      
      // Get AI response with context
      const aiResponse = await sendToAI(message, messageContext);
      
      // Hide typing indicator
      hideTypingIndicator();
      
      // Ensure we have a valid response
      const safeAiResponse = typeof aiResponse === 'string' && aiResponse 
        ? aiResponse 
        : "I'm sorry, I couldn't generate a response. Please try again.";
      
      // Display AI response
      displayMessage(safeAiResponse, 'assistant');
      
      if (!currentConversationId) {
        // Create new conversation
        const result = await createConversationViaREST(
          currentUser.uid, 
          message, 
          await currentUser.getIdToken(),
          safeAiResponse
        );
        
        currentConversationId = result.conversationId;
        
        // Refresh conversation list
        try {
          const conversations = await fetchFirestoreData(currentUser.uid, await currentUser.getIdToken());
          const conversationListElement = document.getElementById('conversationList');
          if (conversationListElement) {
            displayConversationsList(conversations);
          }
        } catch (err) {
          console.error("Error refreshing conversation list:", err);
        }
      } else {
        // Update existing conversation
        await updateConversationViaREST(
          currentUser.uid,
          currentConversationId,
          message,
          safeAiResponse,
          await currentUser.getIdToken()
        );
      }
      
      // Update usage count
      await updateUsageCountViaREST(currentUser.uid, await currentUser.getIdToken());
      
    } catch (error) {
      console.error("Error processing message:", error);
      hideTypingIndicator();
      displayErrorMessage("There was an error processing your message. Please try again.");
    }
  } catch (error) {
    console.error("Error sending message:", error);
    hideTypingIndicator();
    displayErrorMessage("There was an error sending your message. Please try again.");
  }
}

// USER MANAGEMENT FUNCTIONS

// Get current user data
async function getUserData(userId) {
  try {
    const doc = await db.collection('users').doc(userId).get();
    if (doc.exists) {
      return doc.data();
    } else {
      console.error("No user document found for ID:", userId);
      return null;
    }
  } catch (error) {
    console.error("Error getting user data:", error);
    throw error;
  }
}

// Update user subscription tier
async function updateUserSubscription(userId, newTier) {
  try {
    await db.collection('users').doc(userId).update({
      'subscription.tier': newTier,
      'subscription.startDate': firebase.firestore.FieldValue.serverTimestamp(),
      'subscription.endDate': null,
      'subscription.status': 'active'
    });
    
    console.log(`User ${userId} upgraded to ${newTier} tier`);
    return true;
  } catch (error) {
    console.error("Error updating subscription:", error);
    throw error;
  }
}

// Check if user can send message based on tier limits
async function canSendMessage(userId) {
  try {
    const userData = await getUserData(userId);
    
    if (!userData) {
      return { allowed: false, reason: "User data not found" };
    }
    
    const tier = userData.subscription?.tier || 'free';
    const usageCount = userData.usageCount || 0;
    
    // Check limits based on tier
    if (tier === 'free' && usageCount >= 5) {
      return {
        allowed: false,
        reason: "You've reached the maximum of 5 messages on the free tier."
      };
    }
    
    // All paid tiers have unlimited messages
    return { allowed: true };
  } catch (error) {
    console.error("Error checking message limits:", error);
    return { allowed: false, reason: "Error checking message limits" };
  }
}

// Increment usage counter for free tier users
async function incrementUsageCounter(userId) {
  try {
    const userData = await getUserData(userId);
    
    if (!userData) {
      console.error("User data not found when incrementing usage counter");
      return;
    }
    
    // Only increment for free tier users
    if (userData.subscription?.tier === 'free') {
      await db.collection('users').doc(userId).update({
        usageCount: firebase.firestore.FieldValue.increment(1)
      });
      
      console.log(`Incremented usage counter for user ${userId}`);
    }
  } catch (error) {
    console.error("Error incrementing usage counter:", error);
    throw error;
  }
}

// CONVERSATION MANAGEMENT FUNCTIONS

// Get all conversations for a user
async function getUserConversations(userId) {
  try {
    const snapshot = await db.collection('users').doc(userId)
      .collection('conversations')
      .orderBy('updatedAt', 'desc')
      .get();
    
    const conversations = [];
    snapshot.forEach(doc => {
      conversations.push({
        id: doc.id,
        ...doc.data()
      });
    });
    
    return conversations;
  } catch (error) {
    console.error("Error getting conversations:", error);
    throw error;
  }
}

// Get a specific conversation
async function getConversation(userId, conversationId) {
  try {
    const doc = await db.collection('users').doc(userId)
      .collection('conversations').doc(conversationId)
      .get();
    
    if (doc.exists) {
      return {
        id: doc.id,
        ...doc.data()
      };
    } else {
      console.error("Conversation not found:", conversationId);
      return null;
    }
  } catch (error) {
    console.error("Error getting conversation:", error);
    throw error;
  }
}

// Create a new conversation
async function createNewConversation(userId, firstMessage) {
  try {
    // Generate a title based on first message
    const title = generateTitle(firstMessage);
    
    // Create conversation document
    const conversationRef = await db.collection('users').doc(userId)
      .collection('conversations')
      .add({
        title: title,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        messages: []
      });
    
    console.log("Created new conversation:", conversationRef.id);
    
    // Add first message
    await addMessageToConversation(userId, conversationRef.id, firstMessage, 'user');
    
    // Add AI response
    const aiResponse = await sendToAI(firstMessage, []);
    await addMessageToConversation(userId, conversationRef.id, aiResponse, 'assistant');
    
    // Increment usage counter
    await incrementUsageCounter(userId);
    
    return conversationRef.id;
  } catch (error) {
    console.error("Error creating conversation:", error);
    throw error;
  }
}

// Delete a conversation
async function deleteConversation(userId, conversationId) {
  try {
    await db.collection('users').doc(userId)
      .collection('conversations').doc(conversationId)
      .delete();
    
    console.log("Deleted conversation:", conversationId);
    return true;
  } catch (error) {
    console.error("Error deleting conversation:", error);
    throw error;
  }
}

// MESSAGE HANDLING FUNCTIONS

// Add message to conversation
async function addMessageToConversation(userId, conversationId, content, role) {
  try {
    const messageId = generateId();
    const message = {
      id: messageId,
      role: role,
      content: content,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    const conversationRef = db.collection('users').doc(userId)
      .collection('conversations').doc(conversationId);
    
    // Add message to array
    await conversationRef.update({
      messages: firebase.firestore.FieldValue.arrayUnion(message),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    // Display message in UI
    displayMessage(content, role);
    
    console.log(`Added ${role} message to conversation ${conversationId}`);
    return messageId;
  } catch (error) {
    console.error("Error adding message:", error);
    throw error;
  }
}

// Get messages from conversation
async function getMessagesFromConversation(userId, conversationId) {
  try {
    const conversation = await getConversation(userId, conversationId);
    
    if (!conversation) {
      return [];
    }
    
    return conversation.messages || [];
  } catch (error) {
    console.error("Error getting messages:", error);
    throw error;
  }
}

// Process and send message to AI
async function sendMessageWithContext(userId, conversationId, message) {
  try {
    // Add user message to conversation
    await addMessageToConversation(userId, conversationId, message, 'user');
    
    // Show typing indicator
    showTypingIndicator();
    
    // Get conversation context
    const conversation = await getConversation(userId, conversationId);
    const messages = conversation.messages || [];
    
    // Send to AI with context
    const aiResponse = await sendToAI(message, messages);
    
    // Hide typing indicator
    hideTypingIndicator();
    
    // Add AI response to conversation
    await addMessageToConversation(userId, conversationId, aiResponse, 'assistant');
    
    // Increment usage counter
    await incrementUsageCounter(userId);
    
    return true;
  } catch (error) {
    console.error("Error sending message with context:", error);
    hideTypingIndicator();
    throw error;
  }
}

// Updated sendToAI function for Claude-Proxy Netlify Function
async function sendToAI(message, context) {
  console.log("Sending message to Claude via Netlify function proxy");
  console.log("Context length:", context ? context.length : 0);
  
  try {
    // Format the context for Claude
    let formattedContext = [];
    
    if (context && context.length > 0) {
      // Take last 10 messages max to avoid context length issues
      const recentMessages = context.slice(-10);
      
      formattedContext = recentMessages.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      }));
    }
    
    // Use the Netlify function endpoint
    const response = await fetch("/.netlify/functions/claude-proxy", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ 
        message: message,
        context: formattedContext
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Claude proxy error:", response.status, errorText);
      throw new Error(`Claude proxy error: ${response.status}`);
    }
    
    const result = await response.json();
    console.log("Claude proxy response received:", result);
    
    // Extract response from the proxy format
    if (result && result.message) {
      return result.message;
    } else {
      console.error("Unexpected proxy response format:", result);
      throw new Error("Unexpected proxy response format");
    }
  } catch (error) {
    console.error("Error in sendToAI:", error);
    return "I apologize, but I'm having trouble connecting to my knowledge base right now. This could be due to a temporary service disruption. Please try again in a moment.";
  }
}

// UI INTEGRATION FUNCTIONS

// Display conversations in sidebar
function displayConversationsList(conversations) {
  let attempts = 0;
  const maxAttempts = 5;
  
  function tryDisplay() {
    const conversationListElement = document.getElementById('conversationList');
    
    if (!conversationListElement) {
      attempts++;
      if (attempts < maxAttempts) {
        console.log(`Conversation list element not found, retrying... (${attempts}/${maxAttempts})`);
        setTimeout(tryDisplay, 500); // Retry after 500ms
        return;
      } else {
        console.error("Failed to find conversation list element after multiple attempts");
        return;
      }
    }
    
    // Clear existing conversations
    conversationListElement.innerHTML = '';
    
    if (!conversations || conversations.length === 0) {
      // No conversations yet
      conversationListElement.innerHTML = '<div class="text-center text-muted my-3">No conversations yet</div>';
      return;
    }
    
    // Add each conversation to the list
    conversations.forEach(conversation => {
      const conversationElement = document.createElement('div');
      conversationElement.className = 'conversation-item d-flex align-items-center p-2 mb-1 rounded';
      conversationElement.dataset.id = conversation.id;
      
      // Add chat icon
      const iconElement = document.createElement('i');
      iconElement.className = 'bi bi-chat-left-text me-2';
      conversationElement.appendChild(iconElement);
      
      // Add conversation title
      const titleElement = document.createElement('div');
      titleElement.className = 'conversation-title text-truncate';
      titleElement.textContent = conversation.title || 'Untitled Conversation';
      conversationElement.appendChild(titleElement);
      
      // Add click event to load conversation
      conversationElement.addEventListener('click', () => {
        loadConversation(conversation.id);
      });
      
      // Add hover effect with CSS
      conversationElement.style.cursor = 'pointer';
      conversationElement.style.transition = 'background-color 0.2s';
      conversationElement.addEventListener('mouseover', () => {
        conversationElement.style.backgroundColor = '#f0f0f0';
      });
      conversationElement.addEventListener('mouseout', () => {
        conversationElement.style.backgroundColor = '';
      });
      
      conversationListElement.appendChild(conversationElement);
    });
    
    console.log("Displayed conversations:", conversations.length);
  }
  
  // Start the first attempt
  tryDisplay();
}

// Load a conversation into the chat window
async function loadConversation(userId, conversationId) {
  try {
    currentConversationId = conversationId;
    
    // Update active state in sidebar
    const items = document.querySelectorAll('.conversation-item');
    items.forEach(item => {
      if (item.dataset.id === conversationId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
    
    // Get conversation
    const conversation = await getConversation(userId, conversationId);
    
    if (!conversation) {
      displayErrorMessage("Conversation not found");
      return;
    }
    
    // Clear chat window
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = '';
    
    // Display messages
    if (conversation.messages && conversation.messages.length > 0) {
      conversation.messages.forEach(message => {
        displayMessage(message.content, message.role);
      });
    }
    
    // Scroll to bottom
    scrollToBottom();
  } catch (error) {
    console.error("Error loading conversation:", error);
    displayErrorMessage("Error loading conversation");
  }
}

// Display a message in the chat window
function displayMessage(content, role, isError = false) {
  const chatMessages = document.getElementById('chatMessages');
  
  if (!chatMessages) {
    console.error("Chat messages container not found");
    return;
  }
  
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}-message`;
  
  if (isError) {
    messageDiv.classList.add('error-message');
  }
  
  if (role === 'assistant') {
    // Process markdown for AI messages
    messageDiv.innerHTML = marked.parse(content);
    
    // Apply syntax highlighting to code blocks
    messageDiv.querySelectorAll('pre code').forEach(block => {
      hljs.highlightElement(block);
    });
  } else {
    // For user messages, just use text
    messageDiv.textContent = content;
  }
  
  chatMessages.appendChild(messageDiv);
  scrollToBottom();
}

// Display error message
function displayErrorMessage(message) {
  displayMessage(message, 'assistant', true);
}

// Show typing indicator
function showTypingIndicator() {
  const chatMessages = document.getElementById('chatMessages');
  
  // Remove any existing typing indicators
  const existingIndicator = document.querySelector('.typing-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }
  
  const indicator = document.createElement('div');
  indicator.className = 'message ai-message typing-indicator';
  indicator.innerHTML = '<div class="dot-flashing"></div>';
  
  chatMessages.appendChild(indicator);
  scrollToBottom();
}

// Hide typing indicator
function hideTypingIndicator() {
  const indicator = document.querySelector('.typing-indicator');
  if (indicator) {
    indicator.remove();
  }
}

// Clear chat and start new conversation
async function startNewChat() {
  // Clear chat window
  const chatMessages = document.getElementById('chatMessages');
  chatMessages.innerHTML = '';
  
  // Reset current conversation ID
  currentConversationId = null;

  // Update active state in sidebar
  const items = document.querySelectorAll('.conversation-item');
  items.forEach(item => {
    item.classList.remove('active');
  });
}

// Scroll chat window to bottom
function scrollToBottom() {
  const chatMessages = document.getElementById('chatMessages');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// TIER MANAGEMENT FUNCTIONS

// Show upgrade prompt
function showUpgradePrompt(reason) {
  // Create modal HTML
  const modalHTML = `
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">Upgrade Your Account</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">
          <div class="text-center mb-4">
            <i class="bi bi-lock-fill" style="font-size: 3rem;"></i>
            <h4>Free Tier Limit Reached</h4>
            <p>${reason}</p>
          </div>
          <div class="upgrade-options">
            <div class="card mb-3">
              <div class="card-body">
                <h5 class="card-title">Premium Plan</h5>
                <p class="card-text">Unlimited messages and advanced features</p>
                <p class="price">$9.99/month</p>
                <button id="upgradePremiumBtn" class="btn btn-primary w-100">Upgrade to Premium</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Create or get modal element
  let upgradeModal = document.getElementById('upgradeModal');
  
  if (!upgradeModal) {
    upgradeModal = document.createElement('div');
    upgradeModal.className = 'modal fade';
    upgradeModal.id = 'upgradeModal';
    upgradeModal.setAttribute('tabindex', '-1');
    upgradeModal.setAttribute('aria-hidden', 'true');
    document.body.appendChild(upgradeModal);
  }
  
  upgradeModal.innerHTML = modalHTML;
  
  // Set up upgrade button click handler
  const upgradePremiumBtn = document.getElementById('upgradePremiumBtn');
  if (upgradePremiumBtn) {
    upgradePremiumBtn.addEventListener('click', async () => {
      try {
        // Close the modal
        const modal = bootstrap.Modal.getInstance(upgradeModal);
        if (modal) modal.hide();
        
        // Show loading message
        displayMessage("Processing your upgrade...", 'assistant');
        
        // Update user subscription in Firestore via REST
        await upgradeUserSubscriptionViaREST(
          currentUser.uid, 
          'premium', 
          await currentUser.getIdToken()
        );
        
        // Show success message
        displayMessage("Congratulations! You've been upgraded to the premium tier. You now have unlimited access to the chat.", 'assistant');
      } catch (error) {
        console.error("Error upgrading subscription:", error);
        displayErrorMessage("There was an error processing your upgrade. Please try again.");
      }
    });
  }
  
  // Show modal
  const bsModal = new bootstrap.Modal(upgradeModal);
  bsModal.show();
}

// Upgrade user subscription via REST API
async function upgradeUserSubscriptionViaREST(userId, newTier, idToken) {
  try {
    const projectId = firebaseConfig.projectId;
    const userUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
    
    // Use patch to update only the subscription field
    const response = await fetch(`${userUrl}?updateMask.fieldPaths=subscription`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        fields: {
          subscription: {
            mapValue: {
              fields: {
                tier: { stringValue: newTier },
                startDate: { timestampValue: new Date().toISOString() },
                status: { stringValue: 'active' }
              }
            }
          }
        }
      })
    });
    
    if (!response.ok) {
      console.error("Error upgrading subscription:", response.status);
      throw new Error("Subscription upgrade failed");
    }
    
    console.log(`User ${userId} upgraded to ${newTier} tier`);
    return true;
  } catch (error) {
    console.error("Error in upgradeUserSubscriptionViaREST:", error);
    throw error;
  }
}

// Get conversation via REST API
async function getConversationViaREST(userId, conversationId, idToken) {
  try {
    const projectId = firebaseConfig.projectId;
    const conversationUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}/conversations/${conversationId}`;
    
    const response = await fetch(conversationUrl, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!response.ok) {
      console.error("Error fetching conversation:", response.status);
      return null;
    }
    
    const data = await response.json();
    
    // Convert from Firestore format to our app format
    const conversation = {
      id: conversationId,
      title: data.fields?.title?.stringValue || 'Untitled',
      messages: []
    };
    
    // Parse messages array
    if (data.fields?.messages?.arrayValue?.values) {
      data.fields.messages.arrayValue.values.forEach(msgValue => {
        const fields = msgValue.mapValue.fields;
        conversation.messages.push({
          id: fields.id?.stringValue,
          role: fields.role?.stringValue,
          content: fields.content?.stringValue,
          timestamp: fields.timestamp?.timestampValue
        });
      });
    }
    
    return conversation;
  } catch (error) {
    console.error("Error in getConversationViaREST:", error);
    return null;
  }
}

// HELPER FUNCTIONS

// Generate unique ID for messages
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// Create title from first message
function generateTitle(message) {
  // Take first 30 characters of first line
  const firstLine = message.split('\n')[0].trim();
  
  if (firstLine.length <= 30) {
    return firstLine;
  }
  
  return firstLine.substring(0, 30) + '...';
}

// Format context for AI from previous messages
function formatMessagesAsContext(messages) {
  if (!messages || messages.length === 0) {
    return "";
  }
  
  // Take last 10 messages max to avoid context length issues
  const recentMessages = messages.slice(-10);
  
  return recentMessages.map(msg => {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    return `${role}: ${msg.content}`;
  }).join('\n\n');
}

// Format timestamp for display
function formatTimestamp(timestamp) {
  if (!timestamp) {
    return 'Unknown';
  }
  
  // Convert Firestore timestamp to Date
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  
  // Format based on difference
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  
  // For older dates, use actual date
  return date.toLocaleDateString();
}

// Export functions for use in other files
window.startNewChat = startNewChat;
window.initializeChat = initializeChat;

// Function to fetch Firestore data using REST API with Firebase Auth token
async function fetchFirestoreData(userId, idToken) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}/conversations`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Firestore API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Transform Firestore REST response to the format expected by our app
    const conversations = [];
    if (data.documents) {
      for (const doc of data.documents) {
        const id = doc.name.split('/').pop();
        const fields = doc.fields;
        
        const conversation = {
          id: id,
          title: fields.title?.stringValue || "New Conversation",
          createdAt: new Date(fields.createdAt?.timestampValue || Date.now()),
          updatedAt: new Date(fields.updatedAt?.timestampValue || Date.now()),
          messages: []
        };
        
        if (fields.messages?.arrayValue?.values) {
          for (const msg of fields.messages.arrayValue.values) {
            const msgFields = msg.mapValue.fields;
            conversation.messages.push({
              id: msgFields.id?.stringValue,
              role: msgFields.role?.stringValue,
              content: msgFields.content?.stringValue,
              timestamp: new Date(msgFields.timestamp?.timestampValue || Date.now())
            });
          }
        }
        
        conversations.push(conversation);
      }
    }
    
    return conversations;
  } catch (error) {
    console.error("Error fetching from Firestore REST API");
    throw error;
  }
}

// Create database proxies for a user when standard auth fails
function createDatabaseProxies(userId, idToken) {
  console.log("Creating database proxies for user:", userId);
  
  // Load user's conversations
  getUserConversations(userId)
    .then(conversations => {
      displayConversationsList(conversations);
      console.log("Successfully loaded conversations");
    })
    .catch(error => {
      console.error("Error loading conversations:", error);
      
      // Try to modify the security rules at runtime through a custom token
      console.log("Creating a temporary user reference");
      
      // Override the database reference for this user
      // This is a last resort approach
      db.collection('users').doc(userId).get = async function() {
        // Return a default user object
        return {
          exists: true,
          data: () => ({
            subscription: { tier: 'free', status: 'active' },
            usageCount: 0
          })
        };
      };
    });
}

// Check user limits via REST API
async function checkUserLimits(userId, idToken) {
  try {
    // Get user data
    const projectId = firebaseConfig.projectId;
    const userUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
    
    const response = await fetch(userUrl, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!response.ok) {
      console.error("Error fetching user data:", response.status);
      return { allowed: false, reason: "Could not verify user limits" };
    }
    
    const userData = await response.json();
    
    // Extract user tier and usage
    const tier = userData.fields?.subscription?.mapValue?.fields?.tier?.stringValue || 'free';
    const status = userData.fields?.subscription?.mapValue?.fields?.status?.stringValue || 'active';
    const usageCount = parseInt(userData.fields?.usageCount?.integerValue || '0');
    
    console.log(`User tier: ${tier}, Status: ${status}, Usage count: ${usageCount}`);
    
    // Check if subscription is active
    if (tier === 'premium' && status !== 'active') {
      return {
        allowed: false,
        reason: `Your subscription is currently ${status}. Please update your payment information.`
      };
    }
    
    // Check limits based on tier
    if (tier === 'free' && usageCount >= FREE_TIER_LIMIT) {
      return {
        allowed: false,
        reason: `You've reached the limit of ${FREE_TIER_LIMIT} messages on the free tier.`
      };
    }
    
    return { allowed: true };
  } catch (error) {
    console.error("Error checking user limits:", error);
    // Default to allowing the message if we can't check
    return { allowed: true };
  }
}

// Create user document via REST API with proper error handling
async function createUserDocumentViaREST(userId, idToken) {
  const projectId = firebaseConfig.projectId;
  const userUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  
  try {
    console.log("Checking if user document exists...");
    const checkResponse = await fetch(userUrl, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (checkResponse.status === 404) {
      console.log("User document doesn't exist, creating it...");
      
      // Document doesn't exist, create it with complete structure
      const createData = {
        fields: {
          createdAt: { timestampValue: new Date().toISOString() },
          updatedAt: { timestampValue: new Date().toISOString() },
          usageCount: { integerValue: 0 },
          email: { stringValue: currentUser.email || "" },
          displayName: { stringValue: currentUser.displayName || "" },
          subscription: {
            mapValue: {
              fields: {
                tier: { stringValue: "free" },
                status: { stringValue: "active" },
                startDate: { timestampValue: new Date().toISOString() },
                endDate: { nullValue: null },
                stripeCustomerId: { nullValue: null },
                stripeSubscriptionId: { nullValue: null }
              }
            }
          }
        }
      };
      
      const createResponse = await fetch(userUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify(createData)
      });
      
      if (!createResponse.ok) {
        console.error("Failed to create user document:", await createResponse.text());
        return false;
      }
      
      console.log("User document created successfully");
      return true;
    } else if (checkResponse.ok) {
      console.log("User document already exists");
      return true;
    } else {
      console.error("Error checking user document:", checkResponse.status);
      return false;
    }
  } catch (error) {
    console.error("Error creating user document:", error);
    return false;
  }
}

// Create conversation via REST API with both user message and AI response
async function createConversationViaREST(userId, userMessage, idToken, aiResponse) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}/conversations`;
  
  // Ensure we have all required values
  if (!userMessage) {
    console.error("User message is required");
    throw new Error("User message is required");
  }
  
  if (!aiResponse) {
    // If no AI response is provided, get one
    aiResponse = await sendToAI(userMessage, []);
  }
  
  // Ensure aiResponse is a string
  if (typeof aiResponse !== 'string' || !aiResponse) {
    aiResponse = "I'm sorry, I couldn't generate a response. Please try again.";
  }
  
  const title = generateTitle(userMessage);
  const timestamp = new Date().toISOString();
  const userMsgId = generateId();
  const aiMsgId = generateId();
  
  // Create properly formatted document for Firestore REST API
  const conversationData = {
    fields: {
      title: { stringValue: title || "New Conversation" },
      createdAt: { timestampValue: timestamp },
      updatedAt: { timestampValue: timestamp },
      messages: {
        arrayValue: {
          values: [
            // User message
            {
              mapValue: {
                fields: {
                  id: { stringValue: userMsgId },
                  role: { stringValue: "user" },
                  content: { stringValue: userMessage },
                  timestamp: { timestampValue: timestamp }
                }
              }
            },
            // AI response - ensure content is a stringValue
            {
              mapValue: {
                fields: {
                  id: { stringValue: aiMsgId },
                  role: { stringValue: "assistant" },
                  content: { stringValue: aiResponse },
                  timestamp: { timestampValue: timestamp }
                }
              }
            }
          ]
        }
      }
    }
  };
  
  // Log for debugging
  console.log("Creating conversation with data:", JSON.stringify(conversationData));
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify(conversationData)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to create conversation:", errorText);
      throw new Error(`Firestore API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Extract conversation ID from the name path
    const conversationId = data.name.split('/').pop();
    
    // Return the conversation ID and AI response
    return { conversationId, aiResponse };
  } catch (error) {
    console.error("Error creating conversation:", error);
    throw error;
  }
}

// Update existing conversation with new messages
async function updateConversationViaREST(userId, conversationId, userMessage, aiResponse, idToken) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}/conversations/${conversationId}`;
  
  try {
    // First get current conversation
    const getResponse = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!getResponse.ok) {
      console.error("Failed to get conversation:", await getResponse.text());
      throw new Error(`Firestore API error: ${getResponse.status}`);
    }
    
    const conversationData = await getResponse.json();
    const existingMessages = conversationData.fields?.messages?.arrayValue?.values || [];
    const timestamp = new Date().toISOString();
    
    // Add both user message and AI response
    existingMessages.push({
      mapValue: {
        fields: {
          id: { stringValue: generateId() },
          role: { stringValue: 'user' },
          content: { stringValue: userMessage },
          timestamp: { timestampValue: timestamp }
        }
      }
    });
    
    existingMessages.push({
      mapValue: {
        fields: {
          id: { stringValue: generateId() },
          role: { stringValue: 'assistant' },
          content: { stringValue: aiResponse },
          timestamp: { timestampValue: new Date().toISOString() }
        }
      }
    });
    
    // Update conversation
    const updateData = {
      fields: {
        updatedAt: { timestampValue: timestamp },
        messages: {
          arrayValue: {
            values: existingMessages
          }
        }
      }
    };
    
    const updateResponse = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify(updateData)
    });
    
    if (!updateResponse.ok) {
      console.error("Failed to update conversation:", await updateResponse.text());
      throw new Error(`Firestore API error: ${updateResponse.status}`);
    }
    
    return true;
  } catch (error) {
    console.error("Error updating conversation:", error);
    throw error;
  }
}

// Update usage count via REST API
async function updateUsageCountViaREST(userId, idToken) {
  try {
    // Get user data first to check tier
    const projectId = firebaseConfig.projectId;
    const userUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
    
    const getUserResponse = await fetch(userUrl, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!getUserResponse.ok) {
      console.error("Error fetching user data for usage update");
      return false;
    }
    
    const userData = await getUserResponse.json();
    const tier = userData.fields?.subscription?.mapValue?.fields?.tier?.stringValue || 'free';
    
    // Only increment for free tier users
    if (tier === 'free') {
      // Use patch method to increment the counter
      const updateResponse = await fetch(`${userUrl}?updateMask.fieldPaths=usageCount`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          fields: {
            usageCount: {
              integerValue: parseInt(userData.fields?.usageCount?.integerValue || '0') + 1
            }
          }
        })
      });
      
      if (!updateResponse.ok) {
        console.error("Error updating usage count");
        return false;
      }
      
      console.log("Usage count updated successfully");
      return true;
    } else {
      console.log("User on paid tier, not incrementing usage count");
      return true;
    }
  } catch (error) {
    console.error("Error in updateUsageCountViaREST:", error);
    return false;
  }
}

// Make sure this function is called when a user logs in OR sends their first message
async function initializeUser(user) {
  if (!user) return;
  
  console.log("Initializing user document structure...");
  const idToken = await user.getIdToken();
  
  // Log to help with debugging
  console.log(`Creating/updating user document for ${user.uid}`);
  
  const userCreated = await createUserDocumentViaREST(user.uid, idToken);
  console.log(`User document creation result: ${userCreated ? "success" : "failed"}`);
  
  return userCreated;
}

// Call this from the onAuthStateChanged handler
firebase.auth().onAuthStateChanged(async (user) => {
  if (user) {
    // User is signed in
    currentUser = user;
    loggedIn = true;
    updateUserUI(user);
    
    // Initialize user document with correct structure
    await initializeUser(user);
    
    // Rest of your code...
  } else {
    // User is signed out
    // ...
  }
});

// Also call before first message
async function handleChatSubmit(event) {
  // ...
  
  // Ensure user document is properly structured before sending first message
  await initializeUser(currentUser);
  
  // Rest of your handleChatSubmit function...
}
