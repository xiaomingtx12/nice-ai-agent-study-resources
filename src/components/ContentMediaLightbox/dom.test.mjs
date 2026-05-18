import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

import {
  collectMutationDecorationRoots,
  decorateContentMediaSubtree,
  LIGHTBOX_TRIGGER_ATTRIBUTE,
} from './dom.ts';

const styles = {
  triggerImage: 'trigger-image',
  triggerMermaid: 'trigger-mermaid',
};

function setImageDimensions(image, {naturalWidth = 240, naturalHeight = 160} = {}) {
  Object.defineProperties(image, {
    naturalWidth: {
      configurable: true,
      get: () => naturalWidth,
    },
    naturalHeight: {
      configurable: true,
      get: () => naturalHeight,
    },
  });

  image.getBoundingClientRect = () => ({
    width: naturalWidth,
    height: naturalHeight,
    top: 0,
    left: 0,
    right: naturalWidth,
    bottom: naturalHeight,
    x: 0,
    y: 0,
    toJSON() {
      return this;
    },
  });
}

test('collectMutationDecorationRoots returns only added element roots', () => {
  const dom = new JSDOM('<article><div id="mount"></div></article>');
  const {document} = dom.window;
  const mount = document.getElementById('mount');
  const addedImage = document.createElement('img');
  const addedSection = document.createElement('section');

  const roots = collectMutationDecorationRoots([
    {
      addedNodes: [document.createTextNode('ignored'), addedImage, addedSection],
      target: mount,
    },
  ]);

  assert.deepEqual(roots, [addedImage, addedSection]);
});

test('decorateContentMediaSubtree only decorates the provided subtree', () => {
  const dom = new JSDOM(
    `
      <article>
        <img id="existing" src="/existing.png" alt="existing" />
        <div id="mount"></div>
      </article>
    `,
    {pretendToBeVisual: true},
  );
  const {document} = dom.window;
  const existingImage = document.getElementById('existing');
  const mount = document.getElementById('mount');
  const addedSection = document.createElement('section');

  addedSection.innerHTML = `
    <img id="new-image" src="/new-image.png" alt="new" />
    <div class="docusaurus-mermaid-container">
      <svg id="new-mermaid" viewBox="0 0 100 100"></svg>
    </div>
  `;

  const newImage = addedSection.querySelector('#new-image');
  const newMermaid = addedSection.querySelector('#new-mermaid');

  setImageDimensions(existingImage);
  setImageDimensions(newImage);

  Object.defineProperty(newImage, 'complete', {
    configurable: true,
    get: () => false,
  });

  mount.appendChild(addedSection);

  const pendingLoadImages = decorateContentMediaSubtree(addedSection, styles);

  assert.equal(existingImage.classList.contains(styles.triggerImage), false);
  assert.equal(existingImage.hasAttribute(LIGHTBOX_TRIGGER_ATTRIBUTE), false);

  assert.equal(newImage.classList.contains(styles.triggerImage), true);
  assert.equal(newImage.hasAttribute(LIGHTBOX_TRIGGER_ATTRIBUTE), true);

  assert.equal(newMermaid.classList.contains(styles.triggerMermaid), true);
  assert.equal(newMermaid.getAttribute(LIGHTBOX_TRIGGER_ATTRIBUTE), 'true');

  assert.deepEqual(pendingLoadImages, [newImage]);
});
