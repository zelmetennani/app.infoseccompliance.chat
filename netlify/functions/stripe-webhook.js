const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Initialize Firebase Admin if not already
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  try {
    // Verify webhook signature
    const sig = event.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let stripeEvent;
    
    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
    } catch (err) {
      return {
        statusCode: 400,
        body: `Webhook Error: ${err.message}`
      };
    }
    
    // Handle the event
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        const session = stripeEvent.data.object;
        await handleSuccessfulPayment(session);
        break;
        
      case 'customer.subscription.updated':
        const subscription = stripeEvent.data.object;
        await handleSubscriptionUpdate(subscription);
        break;
        
      case 'customer.subscription.deleted':
        const canceledSubscription = stripeEvent.data.object;
        await handleSubscriptionCancellation(canceledSubscription);
        break;
        
      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Webhook processing failed' })
    };
  }
};

// Handle successful payment/checkout
async function handleSuccessfulPayment(session) {
  // Get customer and subscription details
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const userEmail = session.customer_email;
  
  // Find user by metadata (recommended) or email
  let userId;
  
  if (session.client_reference_id) {
    // If you passed the Firebase UID when creating the checkout session
    userId = session.client_reference_id;
  } else {
    // Find user by email (less reliable)
    const userSnapshot = await db.collection('users')
      .where('email', '==', userEmail)
      .limit(1)
      .get();
      
    if (!userSnapshot.empty) {
      userId = userSnapshot.docs[0].id;
    } else {
      console.error('User not found for email:', userEmail);
      return;
    }
  }
  
  // Update user's subscription in Firestore
  await db.collection('users').doc(userId).update({
    'subscription.tier': 'premium',
    'subscription.status': 'active',
    'subscription.startDate': admin.firestore.FieldValue.serverTimestamp(),
    'subscription.endDate': null, // ongoing subscription
    'subscription.stripeCustomerId': customerId,
    'subscription.stripeSubscriptionId': subscriptionId
  });
  
  console.log(`User ${userId} upgraded to premium tier`);
}

// Handle subscription updates
async function handleSubscriptionUpdate(subscription) {
  // Find user by Stripe customer ID
  const customerId = subscription.customer;
  
  const userSnapshot = await db.collection('users')
    .where('subscription.stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
    
  if (userSnapshot.empty) {
    console.error('User not found for Stripe customer:', customerId);
    return;
  }
  
  const userId = userSnapshot.docs[0].id;
  
  // Check subscription status
  let status = 'active';
  
  if (subscription.status === 'past_due' || 
      subscription.status === 'unpaid' || 
      subscription.status === 'incomplete_expired') {
    status = 'past_due';
  } else if (subscription.status === 'canceled' || 
             subscription.status === 'incomplete') {
    status = 'canceled';
  }
  
  // Update subscription status
  await db.collection('users').doc(userId).update({
    'subscription.status': status
  });
  
  console.log(`User ${userId} subscription updated to ${status}`);
}

// Handle subscription cancellation
async function handleSubscriptionCancellation(subscription) {
  // Find user by Stripe customer ID
  const customerId = subscription.customer;
  
  const userSnapshot = await db.collection('users')
    .where('subscription.stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
    
  if (userSnapshot.empty) {
    console.error('User not found for Stripe customer:', customerId);
    return;
  }
  
  const userId = userSnapshot.docs[0].id;
  
  // Calculate end date (subscription remains active until the end of the period)
  const endDate = new Date(subscription.current_period_end * 1000);
  
  // Update user's subscription
  await db.collection('users').doc(userId).update({
    'subscription.status': 'canceled',
    'subscription.endDate': admin.firestore.Timestamp.fromDate(endDate)
  });
  
  console.log(`User ${userId} subscription canceled, effective at ${endDate}`);
} 