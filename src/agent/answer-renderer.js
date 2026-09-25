import DOMPurify from 'dompurify';
import renderMathInElement from 'katex/contrib/auto-render';
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
}).disable([
  'link',
  'image',
  'autolink',
]);

const sanitize = (html) => DOMPurify.sanitize(html, {
  USE_PROFILES: {
    html: true,
    mathMl: true,
  },
  FORBID_TAGS: [
    'a',
    'img',
  ],
  FORBID_ATTR: [
    'href',
    'src',
    'srcset',
  ],
});

export function renderAgentAnswer(answer) {
  const rendered = sanitize(
    markdown.render(String(answer ?? '')),
  );

  const container = document.createElement('div');
  container.innerHTML = rendered;

  renderMathInElement(container, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
    trust: false,
  });

  return sanitize(container.innerHTML);
}