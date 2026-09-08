import { page, esc } from '../brand.js';

export function renderLogin({ error }) {
  return page({
    title: 'Client reporting — sign in',
    home: false,
    body: `<form class="card" method="post" action="/login" autocomplete="off">
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <label for="u">Username</label>
  <input id="u" name="username" required autocapitalize="none" spellcheck="false" autocomplete="username">
  <label for="p">Password</label>
  <input id="p" name="password" type="password" required autocomplete="current-password">
  <button class="primary" type="submit">Open my reports</button>
  <p class="note">Logins are issued by SeaLink Gladstone
  operations. Contact your SeaLink representative to add or remove a user.</p>
</form>`,
  });
}
