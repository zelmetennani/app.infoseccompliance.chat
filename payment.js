// Initialize Stripe client
const stripe = Stripe('YOUR_STRIPE_PUBLISHABLE_KEY');

// Function to start checkout process
async function startCheckout() {
  try {
    if (!currentUser) {
      alert('Please sign in to upgrade');
      return;
    }
    
    // Get the current user's ID token for authentication
    const idToken = await currentUser.getIdToken();
    
    // Call your backend to create a Checkout Session
    const response = await fetch('/.netlify/functions/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({
        userId: currentUser.uid,
        email: currentUser.email,
        plan: 'premium'
      })
    });
    
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const session = await response.json();
    
    // Redirect to Stripe Checkout
    const result = await stripe.redirectToCheckout({
      sessionId: session.id
    });
    
    if (result.error) {
      alert(result.error.message);
    }
  } catch (error) {
    console.error('Error starting checkout:', error);
    alert('Failed to start checkout process. Please try again.');
  }
}

// Attach event listener to upgrade button
document.getElementById('upgradePremiumBtn').addEventListener('click', startCheckout); 