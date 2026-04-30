'use strict';

module.exports = (sequelize, DataTypes) => {
  const Blob = sequelize.define('Blob', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    stepId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'step_id'
    },
    filename: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    mimetype: {
      type: DataTypes.STRING(127),
      allowNull: false
    },
    size: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0
    },
    checksum: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    data: {
      type: DataTypes.BLOB('long'),
      allowNull: false
    }
  }, {
    tableName: 'blobs',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false
  });

  Blob.associate = function associate(models) {
    if (models.MilestoneStep) {
      Blob.belongsTo(models.MilestoneStep, {
        foreignKey: 'stepId',
        as: 'step'
      });
    }
  };

  return Blob;
};
