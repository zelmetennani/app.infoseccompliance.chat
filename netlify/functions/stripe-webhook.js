const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  try {
    const sig = event.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let stripeEvent;
    
    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
    } catch (err) {
      console.error(`⚠️ Webhook signature verification failed: ${err.message}`);
      return {
        statusCode: 400,
        body: `Webhook Error: ${err.message}`
      };
    }
    
    console.log(`✅ Webhook received: ${stripeEvent.type}`);
    const eventType = stripeEvent.type;
    const eventData = stripeEvent.data.object;
    

    switch (eventType) {
      case 'checkout.session.completed':
        await handleSuccessfulCheckout(eventData);
        break;
        
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(eventData);
        break;
        
      case 'customer.subscription.deleted':
        await handleSubscriptionCancellation(eventData);
        break;
        
      case 'invoice.payment_succeeded':
        await handleSuccessfulPayment(eventData);
        break;
        
      case 'invoice.payment_failed':
        await handleFailedPayment(eventData);
        break;
        
      case 'customer.created':
        await handleCustomerCreated(eventData);
        break;
        
      case 'payment_method.attached':
      case 'payment_method.detached':
        await handlePaymentMethodChange(eventData, eventType);
        break;
        
      case 'subscription_schedule.updated':
      case 'subscription_schedule.canceled':
        await handleSubscriptionScheduleChange(eventData, eventType);
        break;
        
      default:
        console.log(`👉 Unhandled event type: ${eventType}`);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };
  } catch (error) {
    console.error(`💥 Error processing webhook: ${error.message}`);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Webhook processing failed' })
    };
  }
};

async function handleSuccessfulCheckout(session) {
  try {
    console.log('Processing checkout.session.completed');
    const customerId = session.customer;
    const subscriptionId = session.subscription;
    let userId=session.client_reference_id;
    if(!userId){
      userId=session.metadata?.userId;
    }
    if(!userId){
      const userEmail=session.customer_email;
      const userSnapshot=await db.collection('users').where('email','==',userEmail).limit(1).get();
      if(!userSnapshot.empty){
        userId = userSnapshot.docs[0].id;
      }else{
        console.error('❌ User not found for checkout session:', session.id);
        return;
      }
    }
    
    // Get subscription details
    const subscription=await stripe.subscriptions.retrieve(subscriptionId);
    const planId=subscription.items.data[0].plan.id;
    const planInterval=subscription.items.data[0].plan.interval;
    await db.collection('users').doc(userId).update({
      'subscription.tier': 'premium',
      'subscription.status': 'active',
      'subscription.startDate': admin.firestore.Timestamp.now(),
      'subscription.endDate': null, // ongoing subscription
      'subscription.stripeCustomerId': customerId,
      'subscription.stripeSubscriptionId': subscriptionId,
      'subscription.stripePlanId': planId,
      'subscription.planInterval': planInterval,
      'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ User ${userId} upgraded to premium tier`);
  } catch (error) {
    console.error(`❌ Error handling checkout session: ${error.message}`);
    throw error;
  }
}

async function handleSubscriptionUpdate(subscription) {
  try {
    console.log(`Processing subscription update: ${subscription.id}`);
    const customerId=subscription.customer;
    const userSnapshot=await db.collection('users').where('subscription.stripeCustomerId','==',customerId).limit(1).get();
    if(userSnapshot.empty){
      console.error(`❌ User not found for Stripe customer: ${customerId}`);
      return;
    }
    const userId = userSnapshot.docs[0].id;
    
    // Get subscription details
    const subscriptionStatus = subscription.status;
    const planId = subscription.items.data[0].plan.id;
    const planInterval = subscription.items.data[0].plan.interval;
    
    // Map Stripe status to our application status
    let status = 'active';
    if (subscriptionStatus === 'past_due' || 
        subscriptionStatus === 'unpaid' || 
        subscriptionStatus === 'incomplete_expired') {
      status = 'past_due';
    } else if (subscriptionStatus === 'canceled' || 
              subscriptionStatus === 'incomplete') {
      status = 'canceled';
    }
    
    // Calculate end date for canceled subscriptions
    let endDate = null;
    if (status === 'canceled') {
      endDate = admin.firestore.Timestamp.fromDate(
        new Date(subscription.current_period_end * 1000)
      );
    }await db.collection('users').doc(userId).update({
      'subscription.status': status,
      'subscription.stripePlanId': planId,
      'subscription.planInterval': planInterval,
      'subscription.endDate':endDate,
      'subscription.lastUpdated': admin.firestore.Timestamp.serverTimestamp()
    });
    
    console.log(`✅ Updated subscription for user ${userId} to ${status}`);
  } catch (error) {
    console.error(`❌ Error handling subscription update: ${error.message}`);
    throw error;
  }
}

async function handleSubscriptionCancellation(subscription) {
  try {
    console.log(`Processing subscription cancellation: ${subscription.id}`);
    const customerId=subscription.customer;
    const userSnapshot=await db.collection('users').where('subscription.stripeCustomerId','==',customerId).limit(1).get();
    if(userSnapshot.empty){
      console.error(`❌ User not found for Stripe customer: ${customerId}`);
      return;
    }
    const userId = userSnapshot.docs[0].id;
    

    const endDate = new Date(subscription.current_period_end * 1000);
    
    // Update user's subscription
    await db.collection('users').doc(userId).update({
      'subscription.status': 'canceled',
      'subscription.endDate': admin.firestore.Timestamp.fromDate(endDate),
      'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Subscription canceled for user ${userId}, effective at ${endDate}`);
  } catch (error) {
    console.error(`❌ Error handling subscription cancellation: ${error.message}`);
    throw error;
  }
}

async function handleSuccessfulPayment(invoice) {
  try {
    console.log(`Processing successful payment: ${invoice.id}`);
    if(!invoice.subscription){
      console.log('Invoice not related to a subscription, skipping');
      return;
    }
    const customerId=invoice.customer;
    const userSnapshot=await db.collection('users').where('subscription.stripeCustomerId','==',customerId).limit(1).get();

      
    if (userSnapshot.empty) {
      console.error(`❌ User not found for Stripe customer: ${customerId}`);
      return;
    }
    
    const userId = userSnapshot.docs[0].id;
    
    await db.collection('users').doc(userId).update({
      'subscription.status': 'active',
      'subscription.lastPaymentDate': admin.firestore.Timestamp.fromDate(
        new Date(invoice.created * 1000)
      ),
      'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Recorded successful payment for user ${userId}`);
  } catch (error) {
    console.error(`❌ Error handling successful payment: ${error.message}`);
    throw error;
  }
}

async function handleFailedPayment(invoice) {
  try {
    console.log(`Processing failed payment: ${invoice.id}`);
    if(!invoice.subscription){
      console.log('Invoice not related to a subscription, skipping');
      return;
    }
    const customerId=invoice.customer;
    const userSnapshot=await db.collection('users').where('subscription.stripeCustomerId','==',customerId).limit(1).get();

      
    if (userSnapshot.empty) {
      console.error(`❌ User not found for Stripe customer: ${customerId}`);
      return;
    }
    
    const userId = userSnapshot.docs[0].id;
    // Update payment status to past_due
    await db.collection('users').doc(userId).update({
      'subscription.status': 'past_due',
      'subscription.lastFailedPaymentDate': admin.firestore.Timestamp.fromDate(
        new Date(invoice.created * 1000)
      ),
      'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`⚠️ Recorded failed payment for user ${userId}`);
  } catch (error) {
    console.error(`❌ Error handling failed payment: ${error.message}`);
    throw error;
  }
}

async function handleCustomerCreated(customer) {
  try {
    console.log(`Processing customer creation: ${customer.id}`);
    if(!customer.email){
      console.log('Customer has no email, skipping');
      return;
    }
    const userSnapshot=await db.collection('users').where('email','==',customer.email).limit(1).get();

    if(userSnapshot.empty){

      console.log(`No user found with email ${customer.email}, skipping`);
      return;
    }
    
    const userId = userSnapshot.docs[0].id;
    
    // Update user with Stripe customer ID
    await db.collection('users').doc(userId).update({
      'subscription.stripeCustomerId': customer.id,
      'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
    });
    
    console.log(`✅ Linked Stripe customer to user ${userId}`);
  } catch (error) {
    console.error(`❌ Error handling customer creation: ${error.message}`);
    throw error;
  }
}

async function handlePaymentMethodChange(paymentMethod, eventType) {
  try {
    console.log(`Processing payment method change: ${eventType}`);
    const customerId=paymentMethod.customer;
    if(!customerId){
      console.log('Payment method not associated with a customer, skipping');
      return;
    }
    const userSnapshot=await db.collection('users').where('subscription.stripeCustomerId','==',customerId).limit(1).get();

    if(userSnapshot.empty){

      console.log(`No user found with Stripe customer ID ${customerId}, skipping`);

      return;
    }
    
    const userId = userSnapshot.docs[0].id;
    
    // Log the payment method change but don't necessarily update user record
    // This is typically used for analytics or notifications
    console.log(`✅ Payment method ${eventType === 'payment_method.attached' ? 'added' : 'removed'} for user ${userId}`);
  } catch (error) {
    console.error(`❌ Error handling payment method change: ${error.message}`);
    throw error;
  }
}

async function handleSubscriptionScheduleChange(schedule, eventType) {
  try {
    console.log(`Processing subscription schedule change: ${eventType}`);
    const customerId=schedule.customer;
    const userSnapshot=await db.collection('users')
      .where('subscription.stripeCustomerId', '==', customerId)

      .limit(1)
      .get();
      
    if (userSnapshot.empty) {
      console.log(`No user found with Stripe customer ID ${customerId}, skipping`);
      return;
    }
    
    const userId=userSnapshot.docs[0].id;
    if(eventType==='subscription_schedule.canceled'){
        await db.collection('users').doc(userId).update({
        'subscription.scheduleCanceled': true,
        'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`✅ Subscription schedule canceled for user ${userId}`);
    }else{
      console.log(`✅ Subscription schedule updated for user ${userId}`);
    }
  } catch (error) {
    console.error(`❌ Error handling subscription schedule change: ${error.message}`);
    throw error;
  }
} 