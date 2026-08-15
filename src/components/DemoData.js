import React from 'react';

// Sample data for demonstration
export const sampleConfigurationData = `Display Name,Cpu Limit,Memory Limit,Min,Max,Current,Desired
user-service,4,8,2,10,3,3
auth-service,2,4,1,5,2,2
payment-service,8,16,3,15,5,5
notification-service,1,2,1,3,1,1
inventory-service,6,12,2,8,4,4
order-service,4,8,2,10,3,3
shipping-service,2,4,1,5,2,2
analytics-service,10,20,2,12,6,6`;

export const sampleMetricsData = `Container Name,Cpu %,Max Cpu %,Avg Memory %,Max Memory %
user-service,15,45,25,60
user-service,12,38,22,55
user-service,18,52,28,65
auth-service,8,25,18,40
auth-service,6,20,15,35
auth-service,10,30,20,45
payment-service,35,85,45,80
payment-service,40,90,50,85
payment-service,30,80,40,75
notification-service,2,8,12,25
notification-service,1,5,10,20
notification-service,3,12,15,30
inventory-service,25,60,35,70
inventory-service,22,55,32,65
inventory-service,28,65,38,75
order-service,20,50,30,60
order-service,18,45,28,55
order-service,22,55,32,65
shipping-service,12,35,20,45
shipping-service,10,30,18,40
shipping-service,15,40,22,50
analytics-service,55,95,65,90
analytics-service,60,98,70,95
analytics-service,50,90,60,85`;

const DemoData = ({ onLoadSampleData }) => {
  return (
    <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
      <h3 className="text-lg font-semibold text-yellow-800 mb-2">Alternative: Try with Sample Data</h3>
      <p className="text-yellow-700 mb-4">
        Want to test with a smaller dataset? Try the application with our sample data to see how it works.
      </p>
      <button
        onClick={() => onLoadSampleData(sampleConfigurationData, sampleMetricsData)}
        className="bg-yellow-600 text-white px-4 py-2 rounded-lg hover:bg-yellow-700 flex items-center gap-2"
      >
        Load Sample Data
      </button>
    </div>
  );
};

export default DemoData;
