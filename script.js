document.addEventListener('DOMContentLoaded', function() {
    const signInForm = document.getElementById('signInForm');
    const waitlistForm = document.getElementById('waitlistForm');
    const confirmationMessage = document.getElementById('confirmationMessage');
    
    // Initialize Firebase Auth
    const auth = firebase.auth();

    // Handle Sign In
    signInForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = document.getElementById('signInEmail').value;
        const password = document.getElementById('signInPassword').value;

        try {
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            const user = userCredential.user;
            
            // Show the waitlist form after successful authentication
            signInForm.classList.add('hidden');
            waitlistForm.classList.remove('hidden');
            
            // Pre-fill email if available
            const emailInput = document.getElementById('email');
            if (user.email) {
                emailInput.value = user.email;
                emailInput.disabled = true;
            }
            
        } catch (error) {
            console.error('Authentication error:', error);
            alert('Error signing in. Please check your credentials and try again.');
        }
    });

    // Handle waitlist form submission
    waitlistForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        const name = document.getElementById('name').value;
        const email = document.getElementById('email').value;

        try {
            // Get current user's ID token
            const user = auth.currentUser;
            if (!user) {
                throw new Error('No authenticated user found');
            }

            const idToken = await user.getIdToken();

            // Send data to Cloudflare Worker
            const response = await fetch('https://1.hackeranalytics0.workers.dev/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    name,
                    email,
                    uid: user.uid
                })
            });

            if (!response.ok) {
                throw new Error('API request failed');
            }

            // Show success message
            waitlistForm.style.display = 'none';
            confirmationMessage.classList.remove('hidden');

        } catch (error) {
            console.error('Error submitting form:', error);
            alert('There was an error submitting the form. Please try again.');
        }
    });
}); 