const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const errorBox = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');

// Only follow same-site relative paths after login
function nextUrl() {
    const next = new URLSearchParams(location.search).get('next');
    return next && next.startsWith('/') && !next.startsWith('//') ? next : '/admin';
}

function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
    passwordInput.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) return showError('Digite seu usuário e senha.');

    showError('');
    loginBtn.disabled = true;
    loginBtn.textContent = 'Entrando…';

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.signup) {
            // First access of an @dreambricks e-mail with the invite password:
            // keep the signed pass out of the address bar and create the user
            sessionStorage.setItem('signup', JSON.stringify({ token: body.token, email: body.email }));
            location.assign('/signup');
            return;
        }
        if (res.ok) {
            location.replace(nextUrl());
            return;
        }
        showError(body.error || `Não foi possível entrar (${res.status})`);
        passwordInput.select();
    } catch (_) {
        showError('Não foi possível falar com o servidor. Verifique sua conexão.');
    }

    loginBtn.disabled = false;
    loginBtn.textContent = 'Entrar';
});
