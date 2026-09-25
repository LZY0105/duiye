import DOMPurify from 'dompurify';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';

const markdown = new MarkdownIt({
    html: false,
}).use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: {
        throwOnError: false,
    },
}).disable([
    'link',
    'image',
    'autolink',
]);

export function renderAgentAnswer(answer) {
    const rendered = markdown.render(String(answer ?? ''));

    return DOMPurify.sanitize(rendered, {
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
}