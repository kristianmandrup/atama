(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.state = factory());
}(this, (function () { 'use strict';

const History = function (initial = []) {
  this.push(...initial);
};

// It is an array
History.prototype = new Array;

// Limit the amout of items to preserve in the history
History.prototype.limit = Infinity;

// Depth: Remove the latest 2 ones: one for history.add(), and another for setProxy
History.prototype.clean = ({ stack = '\nStack not available for ' + navigator.userAgent } = {}) => {

  // Slice: remove the history entry
  // Filter: no empty ones, and no internal ones
  return stack.split('\n').slice(1).filter(one => one).filter(trace => !/^_____/.test(trace)).filter(trace => !/^persistence./.test(trace));
};


History.prototype.add = function (entry) {

  // This is to order them in the console
  this.push(Object.assign({}, entry, {
    timestamp: new Date().getTime(),
    stack: this.clean(new Error(), entry.key === 'length'),
  }, entry));

  if (this.length > this.limit) {
    this.splice(this.length - this.limit);
  }

  return this;
};

// history.type('create|read|update|delete').filter('')
History.prototype.type = function (type) {
  return new History(this.filter(one => one.type === type));
};

// history.key('name|name.subname|name.sub.name')
History.prototype.key = function (key) {
  const current = one => {
    const keyLength = key.split('.').length;
    return one.key.split('.').slice(0, keyLength).join('.') === key;
  };
  return new History(this.filter(current));
};

History.prototype.latest = function (ms = Infinity) {
  return new History(this.filter(one => new Date().getTime() - one.timestamp < ms));
};

var history = new History();

const persistence = {};

// The name of the key to save in localStorage
const key = '_____state';

// Make sure we can work with localStorage
const available = () => typeof window !== 'undefined' && 'localStorage' in window;

// Read the information from localStorage and store it into the state object
persistence.load = (state) => {
  if (!available()) return;

  // Try to retrieve it from localStorage or default to an empty object
  const stored = JSON.parse(localStorage.getItem(key) || "{}");

  // No data was stored => return
  if (!stored.data) return;

  // Store it into our local JSON
  for (let key in stored.data) {
    state[key] = stored.data[key];
  }
};

// Save the data into localStorage for later retrieval
persistence.save = (data) => {
  if (!available()) return;

  const timestamp = new Date().getTime();
  const serialized = JSON.stringify({ timestamp, data });

  localStorage.setItem(key, serialized);
};

// The current total history
// Where the different listeners are attached
const listeners = {};

const basicTypes = ['boolean', 'number', 'null', 'undefined', 'string'];

// Receives the ancestor stack and returns the Proxy() handler
const _____getProxy = (stack = []) => (target, property) => {

  // To allow logging the state: https://github.com/nodejs/node/issues/10731
  if (typeof property === 'symbol') {
    return target[property];
  }

  // Special, internal use
  if ('_____history' === property) { return history; }
  if ('_____listeners' === property) { return listeners; }

  // Create the key for reading
  const key = [...stack.map(one => one.property), property].join('.');

  // Plain access, just return it
  if (property in target) {
    history.add({ type: 'read', key });
    return target[property];
  }

  // If it is a listener return a function to accept the callback
  if (/^\$/.test(property)) {

    // Join all of the call stack so far
    const key = [...stack.map(one => one.property), property.slice(1) || '_____root'].join('.');
    const current = key.split('.').reduce((state, prop) => state[prop], state);
    history.add({ type: 'listen', key });

    // Make sure the listener is defined
    listeners[key] = listeners[key] || [];
    return (callback, def) => {

      // Add it to the list of listeners to be triggered on modification
      listeners[key].push(callback);

      // Trigger once when loading it (except for React)
      if (callback.setState) {
        return callback;
      }

      return callback(current);
    };
  }
};

// Set values
const _____setProxy = (stack = []) => (target, property, value) => {

  if (/^\$/.test(property)) {
    throw new Error('The keys that start by $ are reserved and should not be set manually.');
  }
  if (/^\_\_/.test(property)) {
    throw new Error('The keys that start by __ (two underscores) are reserved and should not be set manually.');
  }

  const key = [...stack.map(one => one.property), property].join('.');

  // Log it into the history
  const type = typeof target[property] === 'undefined' ? 'create' : 'update';
  history.add({ type, key, value });

  // First of all set it in the beginning
  target[property] = value;

  // Make it persist into the localStorage
  persistence.save(state);

  const proxify = (value, stack) => {
    if (basicTypes.includes(typeof value) || value === null) {
      return value;
    }
    if (Array.isArray(value)) {
      value = value.map((value, property, target) => {
        return proxify(value, [...stack, { target, property, value }]);
      });
    }
    if (/^\{/.test(JSON.stringify(value))) {
      for (let property in value) {
        const current = { target, property, value: value[property] };
        value[property] = proxify(value[property], [...stack, current]);
      }
    }

    return new Proxy(value, {
      get: _____getProxy(stack),
      set: _____setProxy(stack),
      deleteProperty: _____delProxy(stack)
    });
  };

  // Proxify the value in-depth
  target[property] = proxify(value, [...stack, { target, property, value }]);


  // Create a list of all the possible listeners so far in the stack
  // state.$card, state.card.$user, state.card.user.$sth, etc
  [...stack, { target, property, value }].forEach((one, i, all) => {
    const key = all.slice(0, i + 1).map(one => one.property).join('.');

    // If listening, find the correct data and pass it down
    if (listeners[key]) {

      // Kudos: https://stackoverflow.com/a/33397682/938236
      const current = key.split('.').reduce((state, prop) => state[prop], state);

      // console.log(current);
      listeners[key].forEach(one => {

        // React.js specific => trigger a repaint
        if (one && one.setState) {
          return one.setState({ __state: Math.random() });
        }

        one(current);
      });
    }
  });

  if (!listeners._____root) return true;

  // Trigger the root listener for any change
  listeners._____root.forEach(one => {

    // React.js specific => trigger a repaint
    if (one && one.setState) {
      return one.setState({ __state: Math.random() });
    }

    one(state);
  });

  return true;
};

const _____delProxy = (stack = []) => (target, property) => {

  if (/^\$/.test(property)) {
    throw new Error('The keys that start by $ are reserved and should not be set manually.');
  }
  if (/^\_\_/.test(property)) {
    throw new Error('The keys that start by __ (two underscores) are reserved and should not be set manually.');
  }

  const key = [...stack.map(one => one.property), property].join('.');
  history.add({ type: 'delete', key });

  // First of all set it in the beginning
  delete target[property];

  persistence.save(state);

  // Create a list of all the possible listeners so far in the stack
  // state.$card, state.card.$user, state.card.user.$sth, etc
  [...stack, { target, property }].forEach((one, i, all) => {
    const key = all.slice(0, i + 1).map(one => one.property).join('.');

    // If listening, find the correct data and pass it down
    if (listeners[key]) {

      // Kudos: https://stackoverflow.com/a/33397682/938236
      const current = key.split('.').reduce((state, prop) => state[prop], state);

      listeners[key].forEach(one => one(current));
    }
  });

  if (!listeners._____root) return true;

  // Trigger the root listener for any change
  listeners._____root.forEach(one => {

    // React.js specific => trigger a repaint
    if (one && one.setState) {
      return one.setState({ __state: Math.random() });
    }

    one(state);
  });

  return true;
};

// Main state function. Has to be defined here to be accessible inside
const state = new Proxy({}, {
  get: _____getProxy(),
  set: _____setProxy(),
  deleteProperty: _____delProxy()
});


// Retrieve the persisted data
persistence.load(state);

return state;

})));
