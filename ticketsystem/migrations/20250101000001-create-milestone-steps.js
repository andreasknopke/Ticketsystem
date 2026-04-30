'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('milestone_steps', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      milestone_id: {
        allowNull: false,
        type: Sequelize.INTEGER,
        references: {
          model: 'milestones',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      text: {
        allowNull: false,
        type: Sequelize.TEXT
      },
      date: {
        allowNull: false,
        type: Sequelize.DATEONLY
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('milestone_steps', ['milestone_id']);
    await queryInterface.addIndex('milestone_steps', ['date']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('milestone_steps');
  }
};
