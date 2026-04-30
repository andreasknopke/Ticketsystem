'use strict';

module.exports = (sequelize, DataTypes) => {
  const MilestoneStep = sequelize.define('MilestoneStep', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    milestoneId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'milestone_id'
    },
    text: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    }
  }, {
    tableName: 'milestone_steps',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  MilestoneStep.associate = function associate(models) {
    if (models.Milestone) {
      MilestoneStep.belongsTo(models.Milestone, {
        foreignKey: 'milestoneId',
        as: 'milestone'
      });
    }

    if (models.Blob) {
      MilestoneStep.hasMany(models.Blob, {
        foreignKey: 'stepId',
        as: 'blobs',
        onDelete: 'CASCADE'
      });
    }
  };

  return MilestoneStep;
};
