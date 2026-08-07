import '../../style.css'
import './banner.css'
import { renderSiteNav, initSiteNav, injectSiteNavStyles, initCompetitionSelector } from '@figureskatingtools/shared-ui'
import { fetchUser, renderSignInView, setupUserMenu, type UserInfo } from '../../shell.js'
import { initGenerator, renderGeneratorPage } from './generator.js'

const appElement = document.querySelector<HTMLDivElement>('#app')!;

// Inject shared nav styles immediately
injectSiteNavStyles();

async function init() {
  // Same auth gate as the rest of the site
  const userInfo = await fetchUser();

  if (!userInfo) {
    renderSignInView(appElement, '/tools/banner/');
  } else {
    renderAuthenticatedView(userInfo);
  }
}

function renderAuthenticatedView(userInfo: UserInfo) {
  appElement.innerHTML = `
    ${renderSiteNav({ activeApp: 'banner', logoUrl: '/logo.png' })}

    ${renderGeneratorPage()}

    <footer class="site-footer">
      <p>Supporting the figure skating community — created with a pinch of AI ❤️</p>
    </footer>
  `;

  // Setup user menu
  const userSection = document.getElementById('fst-nav-right');
  if (userSection) {
    setupUserMenu(userSection, userInfo);
  }

  initSiteNav();

  const competitionSlot = document.getElementById('fst-nav-competition');
  if (competitionSlot) {
    void initCompetitionSelector(competitionSlot);
  }

  initGenerator();
}

init();
