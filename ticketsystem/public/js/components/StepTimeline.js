(function attachStepTimeline(root) {
  'use strict';

  function createElement(tagName, attributes, text) {
    var element = document.createElement(tagName);
    Object.keys(attributes || {}).forEach(function setAttribute(name) {
      if (name === 'className') {
        element.className = attributes[name];
      } else {
        element.setAttribute(name, attributes[name]);
      }
    });
    if (text) {
      element.textContent = text;
    }
    return element;
  }

  function toTime(step) {
    var time = Date.parse(step.date);
    return Number.isNaN(time) ? null : time;
  }

  function StepTimeline(options) {
    this.options = options || {};
    this.apiBasePath = this.options.apiBasePath || ('/api/milestones/' + this.options.milestoneId + '/steps');
    this.container = null;
  }

  StepTimeline.prototype.render = function render(container, steps) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.container) {
      throw new Error('StepTimeline target container not found.');
    }

    if (Array.isArray(steps)) {
      this.draw(steps);
      return;
    }

    fetch(this.apiBasePath).then(function parse(response) {
      if (!response.ok) {
        throw new Error('Timeline-Daten konnten nicht geladen werden.');
      }
      return response.json();
    }).then(this.draw.bind(this)).catch(function failure(error) {
      this.container.textContent = error.message;
    }.bind(this));
  };

  StepTimeline.prototype.draw = function draw(steps) {
    var validSteps = (steps || []).filter(function hasDate(step) {
      return toTime(step) !== null;
    }).sort(function byDate(left, right) {
      return toTime(left) - toTime(right);
    });

    var timeline = createElement('div', { className: 'step-timeline' });
    var axis = createElement('div', { className: 'step-timeline__axis' });
    timeline.appendChild(axis);

    if (!validSteps.length) {
      timeline.appendChild(createElement('p', { className: 'step-timeline__empty' }, 'Keine Schritte für die Zeitleiste vorhanden.'));
    } else {
      var min = toTime(validSteps[0]);
      var max = toTime(validSteps[validSteps.length - 1]);
      var span = Math.max(max - min, 1);

      validSteps.forEach(function appendLabel(step) {
        var tick = createElement('span', { className: 'step-timeline__tick' });
        var offset = ((toTime(step) - min) / span) * 100;
        tick.style.left = offset + '%';
        axis.appendChild(tick);
      });

      validSteps.forEach(function appendMarker(step) {
        var marker = createElement('button', {
          type: 'button',
          className: 'step-timeline__marker',
          title: (step.date || '') + ' - ' + (step.text || '')
        });
        var dot = createElement('span', { className: 'step-timeline__dot' });
        var label = createElement('span', { className: 'step-timeline__label' }, step.date || 'Ohne Datum');
        var offset = ((toTime(step) - min) / span) * 100;
        marker.style.left = offset + '%';
        marker.appendChild(dot);
        marker.appendChild(label);
        marker.addEventListener('click', function notify() {
          if (typeof this.options.onSelect === 'function') {
            this.options.onSelect(step);
          }
        }.bind(this));
        timeline.appendChild(marker);
      }.bind(this));
    }

    this.container.innerHTML = '';
    this.container.appendChild(timeline);
  };

  root.StepTimeline = StepTimeline;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StepTimeline;
  }
})(typeof window !== 'undefined' ? window : globalThis);
