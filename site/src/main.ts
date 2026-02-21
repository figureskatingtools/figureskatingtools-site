import './style.css'
import { renderSiteNav, initSiteNav, injectSiteNavStyles } from '@figureskatingtools/shared-ui'

const SITE_DOMAIN = 'figureskatingtools.com';

/** Detect environment prefix from hostname (dev., test., or empty for prod) */
function getEnvPrefix(): string {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return '';
  const match = hostname.match(/^(dev|test)\./);
  return match ? `${match[1]}.` : '';
}

/** Build a tool URL respecting environment */
function buildToolUrl(subdomain: string): string {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return '#';
  const envPrefix = getEnvPrefix();
  return `https://${envPrefix}${subdomain}.${SITE_DOMAIN}`;
}

interface ToolCard {
  id: string;
  title: string;
  description: string;
  subdomain: string;
  icon: string;
  enabled: boolean;
}

const tools: ToolCard[] = [
  {
    id: 'judgepapers',
    title: 'Judge Paper Creator',
    description: 'Create judging papers for figure skating competitions. Upload PDF exports from Figure Skating Manager and generate ready-to-print judge papers.',
    subdomain: 'judgepapers',
    icon: '📄',
    enabled: true,
  },
  {
    id: 'scoremodifier',
    title: 'Judge Score Modifier',
    description: 'Modify and adjust judge scores for figure skating competitions. Tools for score correction and validation.',
    subdomain: 'scoremodifier',
    icon: '✏️',
    enabled: false,
  },
];

const appElement = document.querySelector<HTMLDivElement>('#app')!;

function renderToolCards(): string {
  return tools.map(tool => {
    const url = tool.enabled ? buildToolUrl(tool.subdomain) : '#';
    const disabledClass = !tool.enabled ? ' tool-card--disabled' : '';
    const badge = !tool.enabled ? '<span class="badge-coming-soon">Coming Soon</span>' : '';
    const tag = tool.enabled ? 'a' : 'div';
    const href = tool.enabled ? ` href="${url}"` : '';

    return `<${tag}${href} class="tool-card${disabledClass}">
      <div class="tool-card-icon">${tool.icon}</div>
      <h3>${tool.title}${badge}</h3>
      <p>${tool.description}</p>
      ${tool.enabled ? '<span class="tool-card-cta">Open tool &rarr;</span>' : ''}
    </${tag}>`;
  }).join('\n');
}

// Render the page
injectSiteNavStyles();

appElement.innerHTML = `
  ${renderSiteNav('home')}

  <main>
    <section class="hero">
      <h1>Figure Skating Tools</h1>
      <p class="hero-subtitle">
        A collection of tools for figure skating competition management and judging.
      </p>
    </section>

    <section class="tools-section" id="tools">
      <h2>Tools</h2>
      <div class="tools-grid">
        ${renderToolCards()}
      </div>
    </section>

    <section class="downloads-section" id="downloads">
      <h2>Downloads</h2>
      <p class="section-description">Add-ons and utilities for figure skating workflows.</p>
      <div class="downloads-grid">
        <div class="download-card">
          <div class="download-card-icon">🎬</div>
          <h3>FSM Stream Deck Add-on</h3>
          <p>Control Figure Skating Manager directly from your Elgato Stream Deck.</p>
          <span class="badge-coming-soon">Coming Soon</span>
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <p>&copy; ${new Date().getFullYear()} Figure Skating Tools</p>
  </footer>
`;

initSiteNav();
