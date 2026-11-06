import test from 'node:test';
import assert from 'node:assert/strict';
import {onRouteUpdate, onRouteDidUpdate, isRouteTransitionPending, subscribeToRouteTransition, serverRouteTransitionSnapshot} from './routeTransition.ts';

const update = (pathname, previous = '/a') => ({location: {pathname}, previousLocation: previous === null ? null : {pathname: previous}});

test('route feedback ignores initial loads and anchors, and ends only for the current destination', async () => {
  let notifications = 0;
  const unsubscribe = subscribeToRouteTransition(() => notifications++);
  onRouteUpdate(update('/a', null));
  onRouteUpdate(update('/a'));
  assert.equal(isRouteTransitionPending(), false);
  onRouteUpdate(update('/b'));
  assert.equal(isRouteTransitionPending(), true);
  assert.equal(serverRouteTransitionSnapshot(), false);
  onRouteUpdate(update('/c', '/b'));
  onRouteDidUpdate(update('/b'));
  assert.equal(isRouteTransitionPending(), true, 'an earlier route must not clear the current loading state');
  onRouteDidUpdate(update('/c', '/b'));
  assert.equal(isRouteTransitionPending(), false);
  await Promise.resolve();
  assert.equal(notifications, 3);
  unsubscribe();
  onRouteUpdate(update('/d', '/c'));
  onRouteDidUpdate(update('/d', '/c'));
  await Promise.resolve();
  assert.equal(notifications, 3);
});


test('returning to the visible article clears a superseded loading indicator', () => {
  onRouteUpdate(update('/b', '/a'));
  assert.equal(isRouteTransitionPending(), true);
  onRouteUpdate(update('/a', '/a'));
  assert.equal(isRouteTransitionPending(), false);
  onRouteDidUpdate(update('/b', '/a'));
  assert.equal(isRouteTransitionPending(), false);
});
