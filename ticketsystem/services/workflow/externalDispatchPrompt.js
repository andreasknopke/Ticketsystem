'use strict';

const EXTERNAL_DISPATCH_PROMPT_BRANCH_TOKEN = '__DOSSIER_BRANCH__';

const EXTERNAL_DISPATCH_PROMPT_TEMPLATE = `Your task is to implement a specific technical requirement based on a dossier found within this Git branch: ${EXTERNAL_DISPATCH_PROMPT_BRANCH_TOKEN}. Source & Context: Access and analyze the requirements, acceptance criteria, and technical specifications. Your Instructions: Analyze the Dossier: Review all documentation (Markdown files) within the linked branch to fully understand the scope of work. Implementation: Execute the task step-by-step. Your code must strictly adhere to the instructions provided in the dossier. Strict Compliance & Inquiry Policy: You are not permitted to deviate from the ticket specifications without prior consultation. Stop your work and request clarification immediately if you encounter: Errors in the Ticket: Contradictory information or technical impossibilities. Unnecessary Complexity: Requirements that introduce "bloat" where a significantly more efficient or standard industry solution exists. Illogical Instructions: Logic that breaks the existing system flow or introduces security vulnerabilities. Response Format: Acknowledge that you have processed the dossier. Briefly outline your implementation plan. Stop and flag any concerns regarding errors, complexity, or logic before writing code. If no issues are found, proceed with the implementation.`;

function buildExternalDispatchPrompt(branch) {
    return EXTERNAL_DISPATCH_PROMPT_TEMPLATE.replace(EXTERNAL_DISPATCH_PROMPT_BRANCH_TOKEN, String(branch || ''));
}

module.exports = {
    EXTERNAL_DISPATCH_PROMPT_BRANCH_TOKEN,
    EXTERNAL_DISPATCH_PROMPT_TEMPLATE,
    buildExternalDispatchPrompt
};