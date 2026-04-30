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
    var grid = createElement('div', { className: 'step-form__grid' });
    var dateField = createElement('div', { className: 'step-form__field' });
    var textField = createElement('div', { className: 'step-form__field step-form__field--wide' });
    var fileField = createElement('div', { className: 'step-form__field step-form__field--wide' });
    var actions = createElement('div', { className: 'step-form__actions' });
    var dateInput = createElement('input', { type: 'date', name: 'date', required: 'required', className: 'form-input' });
    var textInput = createElement('textarea', {
      name: 'text',
      required: 'required',
      placeholder: 'Schritt beschreiben',
      className: 'form-input step-form__textarea',
      rows: '4'
    });
    var fileInput = createElement('input', { type: 'file', name: 'attachments', multiple: 'multiple', className: 'step-form__file-input' });
    var message = createElement('div', { className: 'step-form__message', role: 'status' });
    var submit = createElement('button', { type: 'submit', className: 'btn-primary step-form__submit' }, 'Schritt speichern');
    var hint = createElement('p', { className: 'step-form__hint' }, 'Optional kannst du Dateien oder Screenshots als Anhang mitgeben.');

    dateField.appendChild(createElement('label', { className: 'step-form__label' }, 'Datum'));
    dateField.appendChild(dateInput);

    textField.appendChild(createElement('label', { className: 'step-form__label' }, 'Beschreibung'));
    textField.appendChild(textInput);

    fileField.appendChild(createElement('label', { className: 'step-form__label' }, 'Anhänge'));
    fileField.appendChild(fileInput);
    fileField.appendChild(hint);

    grid.appendChild(dateField);
    grid.appendChild(textField);
    grid.appendChild(fileField);
    form.appendChild(grid);
    actions.appendChild(submit);
    actions.appendChild(message);
    form.appendChild(actions);

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
  message.className = 'step-form__message';
    message.textContent = 'Speichern...';

    fetch(this.apiBasePath, {
      method: 'POST',
      body: data
    }).then(function parse(response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          throw new Error(payload.error || 'Schritt konnte nicht gespeichert werden.');
        });
      }
      return response.json();
    }).then(function success(step) {
      form.reset();
      message.className = 'step-form__message step-form__message--success';
      message.textContent = 'Schritt gespeichert.';
      if (typeof this.options.onSaved === 'function') {
        this.options.onSaved(step);
      }
    }.bind(this)).catch(function failure(error) {
      message.className = 'step-form__message step-form__message--error';
      message.textContent = error.message;
    });
  };

  root.StepForm = StepForm;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StepForm;
  }
})(typeof window !== 'undefined' ? window : globalThis);
