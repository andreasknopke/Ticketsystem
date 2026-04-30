(function attachStepList(root) {
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

  function StepList(options) {
    this.options = options || {};
    this.apiBasePath = this.options.apiBasePath || ('/api/milestones/' + this.options.milestoneId + '/steps');
    this.container = null;
  }

  StepList.prototype.render = function render(container) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.container) {
      throw new Error('StepList target container not found.');
    }
    this.load();
  };

  StepList.prototype.load = function load() {
    if (!this.container) {
      return;
    }
    this.container.textContent = 'Schritte werden geladen...';
    fetch(this.apiBasePath).then(function parse(response) {
      if (!response.ok) {
        throw new Error('Schritte konnten nicht geladen werden.');
      }
      return response.json();
    }).then(this.draw.bind(this)).catch(function failure(error) {
      this.container.textContent = error.message;
    }.bind(this));
  };

  StepList.prototype.draw = function draw(steps) {
    var list = createElement('div', { className: 'step-list' });
    if (!steps || !steps.length) {
      list.appendChild(createElement('p', {}, 'Noch keine Schritte vorhanden.'));
    } else {
      steps.forEach(function appendStep(step) {
        var item = createElement('article', { className: 'step-list__item' });
        item.appendChild(createElement('h4', {}, step.date || 'Ohne Datum'));
        item.appendChild(createElement('p', {}, step.text || ''));

        if (step.blobs && step.blobs.length) {
          var attachments = createElement('ul', { className: 'step-list__attachments' });
          step.blobs.forEach(function appendBlob(blob) {
            var attachment = createElement('li', {});
            var link = createElement('a', {
              href: this.apiBasePath + '/' + step.id + '/attachments/' + blob.id
            }, blob.filename || 'Anhang');
            attachment.appendChild(link);
            if (blob.size) {
              attachment.appendChild(document.createTextNode(' (' + blob.size + ' Bytes)'));
            }
            attachments.appendChild(attachment);
          }.bind(this));
          item.appendChild(attachments);
        }

        if (this.options.allowDelete) {
          var button = createElement('button', { type: 'button' }, 'Löschen');
          button.addEventListener('click', this.remove.bind(this, step.id));
          item.appendChild(button);
        }

        list.appendChild(item);
      }.bind(this));
    }

    this.container.innerHTML = '';
    this.container.appendChild(list);
    if (typeof this.options.onLoaded === 'function') {
      this.options.onLoaded(steps || []);
    }
  };

  StepList.prototype.remove = function remove(stepId) {
    fetch(this.apiBasePath + '/' + stepId, { method: 'DELETE' }).then(function done(response) {
      if (!response.ok) {
        throw new Error('Schritt konnte nicht gelöscht werden.');
      }
      this.load();
    }.bind(this)).catch(function failure(error) {
      if (this.container) {
        this.container.textContent = error.message;
      }
    }.bind(this));
  };

  root.StepList = StepList;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StepList;
  }
})(typeof window !== 'undefined' ? window : globalThis);
