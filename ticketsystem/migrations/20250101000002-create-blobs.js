'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('blobs', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      step_id: {
        allowNull: false,
        type: Sequelize.INTEGER,
        references: {
          model: 'milestone_steps',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      filename: {
        allowNull: false,
        type: Sequelize.STRING(255)
      },
      mimetype: {
        allowNull: false,
        type: Sequelize.STRING(127)
      },
      size: {
        allowNull: false,
        type: Sequelize.INTEGER.UNSIGNED,
        defaultValue: 0
      },
      checksum: {
        allowNull: true,
        type: Sequelize.STRING(64)
      },
      data: {
        allowNull: false,
        type: Sequelize.BLOB('long')
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('blobs', ['step_id']);
    await queryInterface.addIndex('blobs', ['checksum']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('blobs');
  }
};
