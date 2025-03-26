// Initialize Stripe client
const stripe = Stripe(stripePublishableKey);

// Function to start checkout process
async function startCheckout(planType = 'monthly') {
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
        plan: 'premium',
        interval: planType // 'monthly' or 'annual'
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

// Update your upgrade prompt to include both options
function showUpgradePrompt(reason) {
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
                <h5 class="card-title">Premium Monthly</h5>
                <p class="card-text">Unlimited messages and advanced features</p>
                <p class="price">$9.99/month</p>
                <button id="upgradeMonthlyBtn" class="btn btn-primary w-100">Choose Monthly</button>
              </div>
            </div>
            <div class="card">
              <div class="card-body">
                <h5 class="card-title">Premium Annual <span class="badge bg-success">Save 16%</span></h5>
                <p class="card-text">Unlimited messages and advanced features</p>
                <p class="price">$99.99/year <small class="text-muted">(2 months free)</small></p>
                <button id="upgradeAnnualBtn" class="btn btn-primary w-100">Choose Annual</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Create modal element and show
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
  
  // Set up button click handlers
  document.getElementById('upgradeMonthlyBtn').addEventListener('click', () => {
    startCheckout('monthly');
  });
  
  document.getElementById('upgradeAnnualBtn').addEventListener('click', () => {
    startCheckout('annual');
  });
  
  // Show modal
  const bsModal = new bootstrap.Modal(upgradeModal);
  bsModal.show();
}

// Attach event listener to upgrade button
document.getElementById('upgradePremiumBtn').addEventListener('click', () => {
  showUpgradePrompt('Free tier limit reached');
}); 