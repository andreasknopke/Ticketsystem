(function attachStepForm(root) {
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

  function StepForm(options) {
    this.options = options || {};
    this.maxFileSizeBytes = this.options.maxFileSizeBytes || (5 * 1024 * 1024);
    this.apiBasePath = this.options.apiBasePath || ('/api/milestones/' + this.options.milestoneId + '/steps');
  }

  StepForm.prototype.render = function render(container) {
    var target = typeof container === 'string' ? document.querySelector(container) : container;
    if (!target) {
      throw new Error('StepForm target container not found.');
    }

    var form = createElement('form', { className: 'step-form' });
    var dateInput = createElement('input', { type: 'date', name: 'date', required: 'required' });
    var textInput = createElement('textarea', { name: 'text', required: 'required', placeholder: 'Schritt beschreiben' });
    var fileInput = createElement('input', { type: 'file', name: 'attachments', multiple: 'multiple' });
    var message = createElement('div', { className: 'step-form__message', role: 'status' });
    var submit = createElement('button', { type: 'submit' }, 'Schritt speichern');

    form.appendChild(createElement('label', {}, 'Datum'));
    form.appendChild(dateInput);
    form.appendChild(createElement('label', {}, 'Text'));
    form.appendChild(textInput);
    form.appendChild(createElement('label', {}, 'Anhänge'));
    form.appendChild(fileInput);
    form.appendChild(submit);
    form.appendChild(message);

    form.addEventListener('submit', this.handleSubmit.bind(this, form, message));
    target.innerHTML = '';
    target.appendChild(form);
    return form;
  };

  StepForm.prototype.handleSubmit = function handleSubmit(form, message, event) {
    event.preventDefault();
    var files = form.querySelector('input[type="file"]').files;
    for (var index = 0; index < files.length; index += 1) {
      if (files[index].size > this.maxFileSizeBytes) {
        message.textContent = 'Anhang ist größer als das erlaubte Limit.';
        return;
      }
    }

    var data = new FormData(form);
    message.textContent = 'Speichern...';

    fetch(this.apiBasePath, {
      method: 'POST',
      body: data
    }).then(function parse(response) {
      if (!response.ok) {
        throw new Error('Schritt konnte nicht gespeichert werden.');
      }
      return response.json();
    }).then(function success(step) {
      form.reset();
      message.textContent = 'Schritt gespeichert.';
      if (typeof this.options.onSaved === 'function') {
        this.options.onSaved(step);
      }
    }.bind(this)).catch(function failure(error) {
      message.textContent = error.message;
    });
  };

  root.StepForm = StepForm;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StepForm;
  }
})(typeof window !== 'undefined' ? window : globalThis);
