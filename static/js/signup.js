// "Create your user": reached from the login page, which keeps the signed
// sign-up pass in sessionStorage (never in the address bar)
const form = document.getElementById('signupForm');
const nameInput = document.getElementById('name');
const passwordInput = document.getElementById('password');
const password2Input = document.getElementById('password2');
const errorBox = document.getElementById('signupError');
const signupBtn = document.getElementById('signupBtn');

let pass = null;
try { pass = JSON.parse(sessionStorage.getItem('signup') || 'null'); } catch (_) {}

function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = !msg;
}

if (!pass || !pass.token) {
    // Opened directly: start from the login page
    location.replace('/login');
} else {
    document.getElementById('signupEmail').textContent = pass.email;
}

form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const password = passwordInput.value;
    if (name.length < 2) return showError('Digite seu nome.');
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        return showError('A senha precisa ter pelo menos 8 caracteres, com letras e números.');
    }
    if (password !== password2Input.value) return showError('As duas senhas não são iguais.');

    showError('');
    signupBtn.disabled = true;
    signupBtn.textContent = 'Criando…';
    try {
        const res = await fetch('/api/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: pass.token, name, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) {
            sessionStorage.removeItem('signup');
            location.replace('/admin');
            return;
        }
        showError(body.error || `Não foi possível criar o usuário (${res.status})`);
    } catch (_) {
        showError('Não foi possível falar com o servidor. Verifique sua conexão.');
    }
    signupBtn.disabled = false;
    signupBtn.textContent = 'Criar usuário e entrar';
});
