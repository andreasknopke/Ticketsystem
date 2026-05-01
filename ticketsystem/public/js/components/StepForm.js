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
    var titleField = createElement('div', { className: 'step-form__field step-form__field--wide' });
    var dateField = createElement('div', { className: 'step-form__field' });
    var textField = createElement('div', { className: 'step-form__field step-form__field--wide' });
    var fileField = createElement('div', { className: 'step-form__field step-form__field--wide' });
    var actions = createElement('div', { className: 'step-form__actions' });
    var titleInput = createElement('input', {
      type: 'text',
      name: 'title',
      required: 'required',
      placeholder: 'z. B. Abstimmung mit Datenschutz',
      className: 'form-input'
    });
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

    titleField.appendChild(createElement('label', { className: 'step-form__label' }, 'Titel'));
    titleField.appendChild(titleInput);

    dateField.appendChild(createElement('label', { className: 'step-form__label' }, 'Datum'));
    dateField.appendChild(dateInput);

    textField.appendChild(createElement('label', { className: 'step-form__label' }, 'Beschreibung'));
    textField.appendChild(textInput);

    fileField.appendChild(createElement('label', { className: 'step-form__label' }, 'Anhänge'));
    fileField.appendChild(fileInput);
    fileField.appendChild(hint);

    grid.appendChild(titleField);
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

;(function() {
  'use strict';
  document.addEventListener('DOMContentLoaded', function() {
    var modal = document.getElementById('staffModal');
    if (!modal) return;

    function onKindChange() {
      var aiSelected = document.getElementById('staff_kind_ai').checked;
      document.getElementById('aiBlock').classList.toggle('hidden', !aiSelected);
      document.getElementById('systemAssignmentsBlock').classList.toggle('hidden', aiSelected);
      var emailField = document.getElementById('staff_email');
      if (aiSelected) {
        emailField.required = false;
        emailField.readOnly = true;
        emailField.placeholder = 'Bot erhält automatisch E-Mail-Adresse';
        if (!emailField.value || emailField.value === '') {
          emailField.value = 'bot@ticketsystem.local';
        }
      } else {
        emailField.required = true;
        emailField.readOnly = false;
        emailField.placeholder = '';
        if (emailField.value === 'bot@ticketsystem.local') {
          emailField.value = '';
        }
      }
    }

    function setRoleCheckboxes(roles) {
      var roleSet = new Set(roles || []);
      document.querySelectorAll('.role-checkbox').forEach(function(cb) {
        cb.checked = roleSet.has(cb.dataset.role);
      });
    }

    function setSystemCheckboxes(assignments) {
      var assigned = new Set((assignments || []).map(function(a) { return String(a.system_id); }));
      var primary = new Set((assignments || []).filter(function(a) { return a.is_primary; }).map(function(a) { return String(a.system_id); }));
      document.querySelectorAll('.system-checkbox').forEach(function(cb) {
        cb.checked = assigned.has(cb.dataset.systemId);
      });
      document.querySelectorAll('.primary-system-checkbox').forEach(function(cb) {
        cb.checked = primary.has(cb.dataset.systemId);
        cb.disabled = !assigned.has(cb.dataset.systemId);
      });
    }

    window.openStaffModal = function openStaffModal(staff) {
      var isNew = !staff;
      var titleEl = document.getElementById('staffModalTitle');
      if (titleEl) titleEl.textContent = isNew ? 'Neuer Mitarbeiter' : staff.name;
      var nameEl = document.getElementById('staff_name');
      if (nameEl) nameEl.value = isNew ? '' : (staff.name || '');
      var emailEl = document.getElementById('staff_email');
      if (emailEl) emailEl.value = isNew ? '' : (staff.email || '');
      var phoneEl = document.getElementById('staff_phone');
      if (phoneEl) phoneEl.value = isNew ? '' : (staff.phone || '');
      var providerEl = document.getElementById('staff_ai_provider');
      if (providerEl) providerEl.value = isNew ? '' : (staff.ai_provider || '');
      var modelEl = document.getElementById('staff_ai_model');
      if (modelEl) modelEl.value = isNew ? '' : (staff.ai_model || '');
      var tempEl = document.getElementById('staff_ai_temperature');
      if (tempEl) tempEl.value = isNew ? '' : (typeof staff.ai_temperature !== 'undefined' ? staff.ai_temperature : '');
      var maxTokensEl = document.getElementById('staff_ai_max_tokens');
      if (maxTokensEl) maxTokensEl.value = isNew ? '' : (typeof staff.ai_max_tokens !== 'undefined' ? staff.ai_max_tokens : '');
      var promptEl = document.getElementById('staff_ai_system_prompt');
      if (promptEl) promptEl.value = isNew ? '' : (staff.ai_system_prompt || '');
      var extraConfigEl = document.getElementById('staff_ai_extra_config');
      if (extraConfigEl) extraConfigEl.value = isNew ? '' : (staff.ai_extra_config || '');
      var codingLevelEl = document.getElementById('staff_coding_level');
      if (codingLevelEl) codingLevelEl.value = isNew ? '' : (staff.coding_level || '');
      var autoCommitEl = document.getElementById('staff_auto_commit_enabled');
      if (autoCommitEl) autoCommitEl.checked = isNew ? false : !!staff.auto_commit_enabled;
      var kind = isNew ? 'human' : (staff.kind || 'human');
      var humanCheck = document.getElementById('staff_kind_human');
      var aiCheck = document.getElementById('staff_kind_ai');
      if (humanCheck) humanCheck.checked = kind === 'human';
      if (aiCheck) aiCheck.checked = kind === 'ai';
      onKindChange();
      setRoleCheckboxes(isNew ? [] : staff.roles);
      setSystemCheckboxes(isNew ? [] : (staff.system_assignments || []));
      var formEl = document.getElementById('staffEditForm');
      if (formEl) formEl.action = isNew ? '/admin/staff' : ('/admin/staff/' + staff.id + '/update');
      if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
      }
      document.body.classList.add('overflow-hidden');
    };

    window.closeStaffModal = function closeStaffModal() {
      if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
      }
      document.body.classList.remove('overflow-hidden');
    };

    window.onKindChange = onKindChange;

    if (modal) {
      modal.addEventListener('click', function(event) {
        if (event.target === modal) window.closeStaffModal();
      });
    }
    document.addEventListener('keydown', function(event) {
      if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        window.closeStaffModal();
      }
    });

    document.querySelectorAll('.system-checkbox').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var primary = document.querySelector('.primary-system-checkbox[data-system-id="' + this.dataset.systemId + '"]');
        if (!primary) return;
        primary.disabled = !this.checked;
        if (!this.checked) primary.checked = false;
      });
    });

    var formEl = document.getElementById('staffEditForm');
    if (formEl) formEl.action = '/admin/staff';
  });
})();