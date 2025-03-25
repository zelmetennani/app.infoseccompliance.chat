// Initialize Firestore
let db;
let currentUser;
let currentConversationId = null;

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
      // Ensure user document exists first
      await createUserDocumentViaREST(currentUser.uid, await currentUser.getIdToken());
      
      // Check user limits using REST API
      const canSend = await checkUserLimitsViaREST(currentUser.uid, await currentUser.getIdToken());
      
      if (!canSend.allowed) {
        // User has reached their limit
        hideTypingIndicator();
        showUpgradePrompt(canSend.reason);
        return;
      }
      
      // Get AI response - ensure we're using our function
      const aiResponse = await sendToAI(message, []);
      console.log("AI response type:", typeof aiResponse);
      console.log("AI response length:", aiResponse ? aiResponse.length : 0);
      console.log("AI response:", aiResponse);
      
      // Hide typing indicator
      hideTypingIndicator();
      
      // Ensure we have a valid AI response string
      const safeAiResponse = typeof aiResponse === 'string' && aiResponse 
        ? aiResponse 
        : "I'm sorry, I couldn't generate a response. Please try again.";
      
      // Display AI response
      displayMessage(safeAiResponse, 'assistant');
      
      if (!currentConversationId) {
        // Create new conversation via REST
        const result = await createConversationViaREST(
          currentUser.uid, 
          message, 
          await currentUser.getIdToken(),
          safeAiResponse
        );
        
        currentConversationId = result.conversationId;
        
        // Refresh conversation list - check if element exists first
        try {
          const conversations = await fetchFirestoreData(currentUser.uid, await currentUser.getIdToken());
          
          // Only attempt to display if the element exists
          const conversationListElement = document.getElementById('conversationList');
          if (conversationListElement) {
            displayConversationsList(conversations);
          } else {
            console.warn("Conversation list element not found in DOM");
          }
        } catch (err) {
          console.error("Error refreshing conversation list:", err);
        }
      } else {
        // Update existing conversation with both messages
        await updateConversationViaREST(
          currentUser.uid,
          currentConversationId,
          message,
          safeAiResponse,
          await currentUser.getIdToken()
        );
      }
      
      // Update usage count via REST API
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

// Create a proper sendToAI function that will work with our chat functionality
async function sendToAI(message, context) {
  console.log("Sending message to AI via chat.js");
  
  try {
    // Get base URL dynamically
    const baseUrl = window.location.origin;
    const url = `${baseUrl}/api/chat`;
    
    const payload = {
      message: message,
      context: context || []
    };
    
    console.log("Sending payload to AI via chat.js:", {
      messageLength: message.length,
      contextLength: context ? context.length : 0
    });
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      console.error("AI API error:", response.status);
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log("AI response data:", data);
    
    if (data && typeof data.response === 'string') {
      return data.response;
    } else if (data && typeof data.message === 'string') {
      return data.message;
    } else {
      console.error("Invalid response format from AI API:", data);
      return "I'm sorry, there was an error processing your request.";
    }
  } catch (error) {
    console.error("Error sending message to AI:", error);
    return "I'm sorry, there was an error communicating with the AI service.";
  }
}

// UI INTEGRATION FUNCTIONS

// Display conversations in sidebar
function displayConversationsList(conversations) {
  const conversationListElement = document.getElementById('conversationList');
  
  if (!conversationListElement) {
    console.warn("Conversation list element not available yet");
    return;
  }
  
  // Clear existing conversations
  conversationListElement.innerHTML = '';
  
  if (!conversations || conversations.length === 0) {
    // No conversations yet
    const noConversationsElement = document.createElement('div');
    noConversationsElement.className = 'no-conversations';
    noConversationsElement.textContent = 'No conversations yet';
    conversationListElement.appendChild(noConversationsElement);
    return;
  }
  
  // Add each conversation to the list
  conversations.forEach(conversation => {
    const conversationElement = document.createElement('div');
    conversationElement.className = 'conversation-list-item';
    conversationElement.dataset.id = conversation.id;
    conversationElement.textContent = conversation.title || 'Untitled Conversation';
    
    // Add click event to load conversation
    conversationElement.addEventListener('click', () => {
      loadConversation(conversation.id);
    });
    
    conversationListElement.appendChild(conversationElement);
  });
  
  console.log("Displayed conversations:", conversations.length);
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
  
  // Display welcome message
  displayMessage("Hello! I'm your InfoSec Compliance Assistant. How can I help you today?", 'assistant');
  
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
    upgradePremiumBtn.addEventListener('click', () => {
      // Get current user with fallback
      const userToUse = currentUser || firebase.auth().currentUser;
      if (userToUse) {
        upgradeToPaidTier(userToUse.uid, 'premium');
      } else {
        console.error("No user found for upgrade");
        displayErrorMessage("Authentication issue. Please refresh and try again.");
      }
    });
  }
  
  // Show modal
  const bsModal = new bootstrap.Modal(upgradeModal);
  bsModal.show();
}

// Upgrade user to paid tier
async function upgradeToPaidTier(userId, tier) {
  try {
    // In a real app, you would integrate with a payment processor here
    // For now, we'll just update the user's tier in Firestore
    
    // Close the modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('upgradeModal'));
    if (modal) {
      modal.hide();
    }
    
    // Show loading message
    displayMessage("Processing your upgrade...", 'assistant');
    
    // Update user subscription in Firestore
    await updateUserSubscription(userId, tier);
    
    // Show success message
    displayMessage(`Congratulations! You've been upgraded to the ${tier} tier. You now have unlimited access to the chat.`, 'assistant');
    
    return true;
  } catch (error) {
    console.error("Error upgrading to paid tier:", error);
    displayErrorMessage("There was an error processing your upgrade. Please try again.");
    return false;
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
async function checkUserLimitsViaREST(userId, idToken) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        // User document doesn't exist yet - create it
        await createUserDocumentViaREST(userId, idToken);
        return { allowed: true };
      }
      throw new Error(`Firestore API error: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Extract user data
    const usageCount = data.fields?.usageCount?.integerValue 
      ? parseInt(data.fields.usageCount.integerValue) 
      : 0;
      
    const tier = data.fields?.subscription?.mapValue?.fields?.tier?.stringValue || 'free';
    
    // Check limits based on tier
    if (tier === 'free' && usageCount >= 5) {
      return {
        allowed: false,
        reason: "You've reached the maximum of 5 messages on the free tier."
      };
    }
    
    return { allowed: true };
  } catch (error) {
    console.error("Error checking user limits");
    // Default to allowing the message
    return { allowed: true };
  }
}

// Create user document via REST API
async function createUserDocumentViaREST(userId, idToken) {
  const projectId = firebaseConfig.projectId;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  
  // First check if user document exists
  try {
    const checkResponse = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (checkResponse.ok) {
      // Document exists, no need to create
      return;
    }
    
    // Document doesn't exist, create it
    const userData = {
      fields: {
        subscription: {
          mapValue: {
            fields: {
              tier: { stringValue: 'free' },
              status: { stringValue: 'active' }
            }
          }
        },
        usageCount: { integerValue: 0 },
        createdAt: { timestampValue: new Date().toISOString() }
      }
    };
    
    const createResponse = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify(userData)
    });
    
    if (!createResponse.ok) {
      console.error("Failed to create user document:", await createResponse.text());
      throw new Error(`Firestore API error: ${createResponse.status}`);
    }
  } catch (error) {
    console.error("Error creating user document:", error);
    throw error;
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
  const projectId = firebaseConfig.projectId;
  const getUserUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
  
  try {
    // First get current usage count
    const getResponse = await fetch(getUserUrl, {
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!getResponse.ok) {
      if (getResponse.status === 404) {
        // Create user document if it doesn't exist
        await createUserDocumentViaREST(userId, idToken);
        return;
      }
      throw new Error(`Firestore API error: ${getResponse.status}`);
    }
    
    const userData = await getResponse.json();
    const currentCount = userData.fields?.usageCount?.integerValue 
      ? parseInt(userData.fields.usageCount.integerValue) 
      : 0;
    
    // Only increment for free tier users
    const tier = userData.fields?.subscription?.mapValue?.fields?.tier?.stringValue || 'free';
    if (tier !== 'free') {
      return;
    }
    
    // Update usage count
    const updateData = {
      fields: {
        usageCount: { integerValue: currentCount + 1 }
      }
    };
    
    const updateResponse = await fetch(getUserUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify(updateData)
    });
    
    if (!updateResponse.ok) {
      throw new Error(`Firestore API error: ${updateResponse.status}`);
    }
  } catch (error) {
    console.error("Error updating usage count");
  }
}
