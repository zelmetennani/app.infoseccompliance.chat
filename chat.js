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

  // Add debug info about Firebase initialization state
  console.log("Firebase apps count:", firebase.apps.length);
  console.log("Firebase Auth initialized:", !!firebase.auth());
  
  // Print all cookies for debugging
  console.log("All cookies available:", document.cookie);
  
  // Key insight: In Firebase v9 compatibility mode, we need to wait for the auth state
  // This is the pattern used in index.html that works correctly
  firebase.auth().onAuthStateChanged(function(user) {
    console.log("Auth state changed event fired");
    
    if (user) {
      // User is signed in
      currentUser = user;
      console.log("Auth state changed - User is signed in:", user.uid);
      
      // Load user's conversations
      getUserConversations(user.uid)
        .then(conversations => {
          displayConversationsList(conversations);
        })
        .catch(error => {
          console.error("Error loading conversations:", error);
        });
        
      // Check if we need to display welcome message
      if (!currentConversationId) {
        displayMessage("Hello! I'm your InfoSec Compliance Assistant. How can I help you today?", 'assistant');
      }
    } else {
      // User is signed out
      console.log("Auth state changed - No user signed in");
      
      // Check if we need to get the current user in a different way
      // Important: Just log this, no extra auth attempts that might interfere
      console.log("Current auth user check:", firebase.auth().currentUser);
    }
  });
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
    // Check for user in multiple ways
    let userToUse = currentUser || firebase.auth().currentUser;
    
    if (!userToUse) {
      console.error("User not authenticated");
      console.log("Current auth state:", firebase.auth().currentUser);
      console.log("Stored current user:", currentUser);
      console.log("Available cookies:", document.cookie);
      
      displayErrorMessage("Authentication issue. Please try refreshing the page.");
      return;
    }
    
    console.log("Using user:", userToUse.uid);
    
    // Display user message
    displayMessage(message, 'user');
    
    // Show typing indicator
    showTypingIndicator();
    
    // Check if user can send message based on tier limits
    const canSend = await canSendMessage(userToUse.uid);
    
    if (!canSend.allowed) {
      // User has reached their limit
      hideTypingIndicator();
      showUpgradePrompt(canSend.reason);
      return;
    }
    
    if (currentConversationId) {
      // Add to existing conversation
      await sendMessageWithContext(userToUse.uid, currentConversationId, message);
    } else {
      // Create new conversation
      const conversationId = await createNewConversation(userToUse.uid, message);
      currentConversationId = conversationId;
      console.log("Created new conversation with ID:", conversationId);
      
      // Refresh conversation list
      const conversations = await getUserConversations(userToUse.uid);
      displayConversationsList(conversations);
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

// Send message to AI
async function sendToAI(message, previousMessages) {
  try {
    // Format context from previous messages
    const context = formatMessagesAsContext(previousMessages);
    
    console.log("Sending message to AI service");
    
    // Check if Claude API key is available
    if (!window.claudeConfig || !window.claudeConfig.apiKey) {
      console.error("Claude API key not found");
      return "Sorry, the AI service is currently unavailable. Please try again later.";
    }
    
    // Prepare request payload
    const requestBody = {
      message: message,
      context: context
    };
    
    // Send request to Netlify function
    const response = await fetch('/.netlify/functions/claude-proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': window.claudeConfig.apiKey
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API error (${response.status}):`, errorText);
      return `Sorry, there was an error communicating with the AI service (${response.status}). Please try again later.`;
    }
    
    const data = await response.json();
    console.log("Received response from AI");
    
    return data.response;
  } catch (error) {
    console.error("Error sending to AI:", error);
    return "Sorry, there was an error processing your message. Please try again.";
  }
}

// UI INTEGRATION FUNCTIONS

// Display conversations in sidebar
function displayConversationsList(conversations) {
  const conversationList = document.getElementById('conversationList');
  
  if (!conversationList) {
    console.error("Conversation list element not found");
    return;
  }
  
  // Clear existing list
  conversationList.innerHTML = '';
  
  if (!conversations || conversations.length === 0) {
    conversationList.innerHTML = '<div class="no-conversations">No conversations yet</div>';
    return;
  }
  
  // Add each conversation
  conversations.forEach(conversation => {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.dataset.id = conversation.id;
    
    if (currentConversationId === conversation.id) {
      item.classList.add('active');
    }
    
    const date = formatTimestamp(conversation.updatedAt);
    
    item.innerHTML = `
      <div class="conversation-title">${conversation.title}</div>
      <div class="conversation-date">${date}</div>
    `;
    
    item.addEventListener('click', () => loadConversation(currentUser.uid, conversation.id));
    
    conversationList.appendChild(item);
  });
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
