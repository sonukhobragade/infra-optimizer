import React, { useState } from 'react';
import { Download, Search, TrendingUp, TrendingDown, Zap } from 'lucide-react';
import Papa from 'papaparse';
import _ from 'lodash';
import {
  calculateJavaRecommendations,
  getRecommendationType,
} from '../utils/recommendations';
import DemoData from './DemoData';

// Optional sample exports; nothing ships under these names.
const CONFIG_CSV_NAME = 'service-config.csv';
const METRICS_CSV_NAME = 'service-metrics.csv';

const JavaServiceOptimizer = () => {
  const [data, setData] = useState({ file1: null, file2: null });
  const [recommendations, setRecommendations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [parseError, setParseError] = useState(null);

  const processFiles = async () => {
    setLoading(true);
    try {
      let file1Content, file2Content;
      
      if (data.file1 && data.file2) {
        file1Content = data.file1;
        file2Content = data.file2;
      } else {
        // Optional convenience: if a deployment drops sample exports into
        // public/csv under these names, load them instead of asking for an
        // upload. None ship with the repository, so this normally 404s and
        // falls through to the upload prompt below.
        try {
          const response1 = await fetch(`/csv/${CONFIG_CSV_NAME}`);
          const response2 = await fetch(`/csv/${METRICS_CSV_NAME}`);
          
          if (response1.ok && response2.ok) {
            file1Content = await response1.text();
            file2Content = await response2.text();
            console.log('Loaded CSV files from csv folder');
          } else {
            alert('Please upload both configuration and metrics CSV files first.');
            setLoading(false);
            return;
          }
        } catch (error) {
          console.error('Error loading CSV files:', error);
          alert('Please upload both configuration and metrics CSV files first.');
          setLoading(false);
          return;
        }
      }

      const file1Data = Papa.parse(file1Content, { header: true, dynamicTyping: true, skipEmptyLines: true });
      const file2Data = Papa.parse(file2Content, { header: true, dynamicTyping: true, skipEmptyLines: true });

      // PapaParse reports problems on .errors rather than throwing, so
      // ignoring it meant a truncated or malformed export produced a shorter
      // recommendation table with no indication that rows had been dropped.
      // A capacity plan missing half the fleet looks exactly like a capacity
      // plan for a smaller fleet.
      const parseProblem = (label, parsed) => {
        if (!parsed.meta || !parsed.meta.fields) {
          return `${label}: no header row found. Export it as CSV with a header.`;
        }
        if (parsed.errors && parsed.errors.length > 0) {
          const first = parsed.errors[0];
          const where = typeof first.row === 'number' ? ` at row ${first.row + 2}` : '';
          return `${label}: ${parsed.errors.length} parse error(s), first${where}: ${first.message}`;
        }
        if (parsed.data.length === 0) {
          return `${label}: parsed successfully but contains no data rows.`;
        }
        return null;
      };

      const problem = parseProblem('Configuration CSV', file1Data)
        || parseProblem('Metrics CSV', file2Data);
      if (problem) {
        console.error('CSV parse failed:', problem);
        setParseError(problem);
        // Clear the previous run. Leaving the old table and its export button
        // on screen next to a parse error invites exporting a plan that
        // belongs to different data.
        setRecommendations([]);
        setLoading(false);
        return;
      }
      setParseError(null);

      // Trim the headers AND the row keys. Rewriting meta.fields alone left
      // every parsed row still keyed by the untrimmed header, so an export
      // with " Display Name " parsed cleanly and then matched nothing,
      // producing an empty analysis rather than an error.
      const trimKeys = (parsed) => {
        parsed.meta.fields = parsed.meta.fields.map(field => field.trim());
        parsed.data = parsed.data.map(row =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [String(k).trim(), v]),
          ),
        );
      };
      trimKeys(file1Data);
      trimKeys(file2Data);

      // Validate the documented schema. Missing metric columns used to become
      // 0 and missing limits 1 or 2, so an export with the wrong headers
      // produced confident, aggressive reductions from no data at all.
      const REQUIRED_CONFIG = ['Display Name', 'Cpu Limit', 'Memory Limit'];
      const REQUIRED_METRICS = ['Container Name', 'Cpu %', 'Max Cpu %',
                                'Avg Memory %', 'Max Memory %'];
      const missing = (label, fields, required) => {
        const absent = required.filter(c => !fields.includes(c));
        return absent.length
          ? `${label} is missing required column(s): ${absent.join(', ')}.`
          : null;
      };
      const schemaProblem =
        missing('Configuration CSV', file1Data.meta.fields, REQUIRED_CONFIG)
        || missing('Metrics CSV', file2Data.meta.fields, REQUIRED_METRICS);
      if (schemaProblem) {
        console.error('CSV schema mismatch:', schemaProblem);
        setParseError(schemaProblem);
        setRecommendations([]);
        setLoading(false);
        return;
      }

      const usageByService = _.groupBy(file2Data.data, row => row['Container Name']);
      
      const serviceRecommendations = file1Data.data
        .filter(row => row['Display Name'])
        .map(currentConfig => {
          const serviceName = currentConfig['Display Name'];
          const usageRecords = usageByService[serviceName] || [];
          
          if (usageRecords.length === 0) {
            return null;
          }

          const usage = usageRecords.map(record => ({
            cpuPercent: record['Cpu %'] || 0,
            maxCpuPercent: record['Max Cpu %'] || 0,
            avgMemoryPercent: record['Avg Memory %'] || 0,
            maxMemoryPercent: record['Max Memory %'] || 0
          }));

          const current = {
            cpuLimit: currentConfig['Cpu Limit'] || 1,
            memoryLimit: currentConfig['Memory Limit'] || 2,
            minPods: currentConfig['Min'] || 1,
            maxPods: currentConfig['Max'] || 1,
            currentPods: currentConfig['Current'] || 1,
            desiredPods: currentConfig['Desired'] || 1
          };

          const recommended = calculateJavaRecommendations(usage, current);

          const cpuDiff = recommended.cpu - current.cpuLimit;
          const memoryDiff = recommended.memory - current.memoryLimit;
          const podsDiff = recommended.pods - current.currentPods;
          
          const totalCurrentCpu = current.cpuLimit * current.currentPods;
          const totalCurrentMemory = current.memoryLimit * current.currentPods;
          const totalRecommendedCpu = recommended.cpu * recommended.pods;
          const totalRecommendedMemory = recommended.memory * recommended.pods;
          
          const avgCpuPercent = usage.reduce((sum, u) => sum + u.cpuPercent, 0) / usage.length;
          const avgMemoryPercent = usage.reduce((sum, u) => sum + u.avgMemoryPercent, 0) / usage.length;
          const maxCpuPercent = Math.max(...usage.map(u => u.maxCpuPercent));
          const maxMemoryPercent = Math.max(...usage.map(u => u.maxMemoryPercent));

          return {
            serviceName,
            pods: {
              min: current.minPods,
              max: current.maxPods,
              current: current.currentPods,
              desired: current.desiredPods
            },
            current: {
              cpu: current.cpuLimit,
              memory: current.memoryLimit
            },
            recommended: {
              cpu: recommended.cpu,
              memory: recommended.memory,
              pods: recommended.pods
            },
            // Three optimization strategies
            strategies: {
              // Strategy 1: VPA Only (keep same pods, optimize resources)
              vpaOnly: {
                cpu: recommended.cpu * current.currentPods,
                memory: recommended.memory * current.currentPods,
                pods: current.currentPods,
                cpuSavings: (current.cpuLimit - recommended.cpu) * current.currentPods,
                memorySavings: (current.memoryLimit - recommended.memory) * current.currentPods
              },
              // Strategy 2: HPA Only (keep same resources, optimize pods) 
              hpaOnly: {
                cpu: current.cpuLimit * recommended.pods,
                memory: current.memoryLimit * recommended.pods,
                pods: recommended.pods,
                cpuSavings: current.cpuLimit * (current.currentPods - recommended.pods),
                memorySavings: current.memoryLimit * (current.currentPods - recommended.pods)
              },
              // Strategy 3: Combined (optimize both)
              combined: {
                cpu: recommended.cpu * recommended.pods,
                memory: recommended.memory * recommended.pods, 
                pods: recommended.pods,
                cpuSavings: totalCurrentCpu - totalRecommendedCpu,
                memorySavings: totalCurrentMemory - totalRecommendedMemory
              }
            },
            totalCluster: {
              currentCpu: totalCurrentCpu,
              currentMemory: totalCurrentMemory,
              recommendedCpu: totalRecommendedCpu,
              recommendedMemory: totalRecommendedMemory,
              cpuSavings: totalCurrentCpu - totalRecommendedCpu,
              memorySavings: totalCurrentMemory - totalRecommendedMemory
            },
            usage: {
              avgCpuPercent: Math.round(avgCpuPercent),
              avgMemoryPercent: Math.round(avgMemoryPercent),
              maxCpuPercent: Math.round(maxCpuPercent),
              maxMemoryPercent: Math.round(maxMemoryPercent),
              dataPoints: usage.length
            },
            changes: {
              cpu: cpuDiff,
              memory: memoryDiff,
              pods: podsDiff
            },
            recommendation: getRecommendationType(avgCpuPercent, avgMemoryPercent, cpuDiff, memoryDiff, podsDiff)
          };
        })
        .filter(rec => rec !== null);

      setRecommendations(serviceRecommendations);
    } catch (error) {
      console.error('Error processing files:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = (fileKey, event) => {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setData(prev => ({ ...prev, [fileKey]: e.target.result }));
      };
      reader.readAsText(file);
    }
  };

  const handleLoadSampleData = (configData, metricsData) => {
    setData({
      file1: configData,
      file2: metricsData
    });
  };

  const exportRecommendations = () => {
    const csvData = recommendations.map(rec => ({
      'Service Name': rec.serviceName,
      'Current Setup': `${rec.pods.current} pods × ${rec.current.cpu}CPU × ${rec.current.memory}GB`,
      'Current Total CPU': rec.totalCluster.currentCpu,
      'Current Total Memory': rec.totalCluster.currentMemory,
      
      // VPA Strategy
      'VPA Strategy': `${rec.pods.current} pods × ${rec.recommended.cpu}CPU × ${rec.recommended.memory}GB`,
      'VPA Total CPU': rec.strategies.vpaOnly.cpu,
      'VPA Total Memory': rec.strategies.vpaOnly.memory,
      'VPA CPU Savings': rec.strategies.vpaOnly.cpuSavings,
      'VPA Memory Savings': rec.strategies.vpaOnly.memorySavings,
      
      // HPA Strategy  
      'HPA Strategy': `${rec.recommended.pods} pods × ${rec.current.cpu}CPU × ${rec.current.memory}GB`,
      'HPA Total CPU': rec.strategies.hpaOnly.cpu,
      'HPA Total Memory': rec.strategies.hpaOnly.memory,
      'HPA CPU Savings': rec.strategies.hpaOnly.cpuSavings,
      'HPA Memory Savings': rec.strategies.hpaOnly.memorySavings,
      
      // Combined Strategy
      'Combined Strategy': `${rec.recommended.pods} pods × ${rec.recommended.cpu}CPU × ${rec.recommended.memory}GB`,
      'Combined Total CPU': rec.strategies.combined.cpu,
      'Combined Total Memory': rec.strategies.combined.memory,
      'Combined CPU Savings': rec.strategies.combined.cpuSavings,
      'Combined Memory Savings': rec.strategies.combined.memorySavings,
      
      'Avg CPU %': rec.usage.avgCpuPercent,
      'Max CPU %': rec.usage.maxCpuPercent,
      'Avg Memory %': rec.usage.avgMemoryPercent,
      'Max Memory %': rec.usage.maxMemoryPercent
    }));

    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'java-optimization-strategies.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // String(): dynamicTyping turns an all-numeric service name such as "123"
  // into a number, and calling toLowerCase on it threw during render and took
  // the whole component down.
  const filteredRecommendations = recommendations.filter(rec =>
    String(rec.serviceName ?? '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const sortedRecommendations = _.orderBy(filteredRecommendations, [
    sortBy === 'savings' ? 'totalCluster.cpuSavings' : 'serviceName'
  ], [sortBy === 'savings' ? 'desc' : 'asc']);

  const getRecommendationColor = (type) => {
    const colors = {
      'SCALE_UP': 'text-red-600 bg-red-50',
      'OPTIMIZE_UP': 'text-orange-600 bg-orange-50', 
      'SCALE_DOWN': 'text-green-600 bg-green-50'
    };
    return colors[type] || 'text-blue-600 bg-blue-50';
  };

  const getRecommendationIcon = (type) => {
    if (type === 'SCALE_UP' || type === 'OPTIMIZE_UP') {
      return <TrendingUp className="w-4 h-4" />;
    } else if (type === 'SCALE_DOWN') {
      return <TrendingDown className="w-4 h-4" />;
    }
    return <Zap className="w-4 h-4" />;
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Java Service Resource Optimizer</h1>
        <p className="text-gray-600">Optimize CPU, Memory, and Pod Count for Java services</p>
      </div>

      {parseError && (
        <div className="mb-6 bg-red-50 border border-red-300 rounded-lg p-4" role="alert">
          <h3 className="text-lg font-semibold text-red-800 mb-1">Could not read the CSV</h3>
          <p className="text-red-700 text-sm">{parseError}</p>
          <p className="text-red-700 text-sm mt-2">
            No recommendations are shown, because a partially parsed export
            produces a plan for a smaller fleet than you actually have.
          </p>
        </div>
      )}

      <div className="mb-6 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h3 className="text-lg font-semibold text-blue-800 mb-2">Data Sources</h3>
        <p className="text-blue-700 mb-4">
          Upload your configuration and metrics exports, or place them in the csv folder to have them loaded automatically.
        </p>
        
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-blue-700 text-sm">
            Upload a configuration export and a metrics export below. If you
            place them in <code>public/csv</code> as <code>{CONFIG_CSV_NAME}</code>
            and <code>{METRICS_CSV_NAME}</code> they are picked up automatically.
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-blue-800 mb-2">
              Configuration File (CSV) - Optional
            </label>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => handleFileUpload('file1', e)}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            <p className="text-xs text-blue-600 mt-1">Contains current resource limits and pod configurations</p>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-blue-800 mb-2">
              Metrics File (CSV) - Optional
            </label>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => handleFileUpload('file2', e)}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            <p className="text-xs text-blue-600 mt-1">Contains usage metrics (CPU %, Memory %, etc.)</p>
          </div>
        </div>
        
        {data.file1 && data.file2 && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-green-700 text-sm">✅ Custom files uploaded successfully!</p>
          </div>
        )}
      </div>

      <DemoData onLoadSampleData={handleLoadSampleData} />

      <div className="flex gap-4 mb-6">
        <button
          onClick={processFiles}
          disabled={loading}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? 'Analyzing...' : 'Analyze with CSV Data'}
          <Zap className="w-4 h-4" />
        </button>

        {recommendations.length > 0 && (
          <button
            onClick={exportRecommendations}
            className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 flex items-center gap-2"
          >
            Export CSV
            <Download className="w-4 h-4" />
          </button>
        )}
      </div>

      {recommendations.length > 0 && (
        <>
          <div className="flex gap-4 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search services..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg w-full focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="name">Sort by Name</option>
              <option value="savings">Sort by Savings</option>
            </select>
          </div>

          <div className="bg-white rounded-lg shadow-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Service</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Current Setup</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">VPA Only<br/>(Resource Opt)</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">HPA Only<br/>(Pod Opt)</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Combined<br/>(Both)</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Usage Patterns</th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {sortedRecommendations.map((rec, index) => (
                    <tr key={rec.serviceName} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{rec.serviceName}</div>
                        <div className="text-xs text-gray-500">{rec.usage.dataPoints} data points</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center text-sm">
                        <div className="font-medium">{rec.pods.current} pods</div>
                        <div>{rec.current.cpu} CPU × {rec.current.memory}GB</div>
                        <div className="text-xs text-gray-500">
                          Total: {rec.totalCluster.currentCpu} CPU, {rec.totalCluster.currentMemory}GB
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center text-sm">
                        <div className="font-medium">{rec.pods.current} pods</div>
                        <div className={rec.strategies.vpaOnly.cpuSavings > 0 ? 'text-green-600' : 'text-gray-900'}>
                          {rec.recommended.cpu} CPU × {rec.recommended.memory}GB
                        </div>
                        <div className="text-xs">
                          Total: {rec.strategies.vpaOnly.cpu} CPU, {rec.strategies.vpaOnly.memory}GB
                        </div>
                        {rec.strategies.vpaOnly.cpuSavings > 0 && (
                          <div className="text-xs text-green-600 font-medium">
                            💰 Save: {rec.strategies.vpaOnly.cpuSavings} CPU, {rec.strategies.vpaOnly.memorySavings}GB
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center text-sm">
                        <div className={`font-medium ${rec.strategies.hpaOnly.cpuSavings > 0 ? 'text-green-600' : 'text-gray-900'}`}>
                          {rec.recommended.pods} pods
                        </div>
                        <div>{rec.current.cpu} CPU × {rec.current.memory}GB</div>
                        <div className="text-xs">
                          Total: {rec.strategies.hpaOnly.cpu} CPU, {rec.strategies.hpaOnly.memory}GB
                        </div>
                        {rec.strategies.hpaOnly.cpuSavings > 0 && (
                          <div className="text-xs text-green-600 font-medium">
                            💰 Save: {rec.strategies.hpaOnly.cpuSavings} CPU, {rec.strategies.hpaOnly.memorySavings}GB
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center text-sm">
                        <div className={`font-medium ${rec.strategies.combined.cpuSavings > 0 ? 'text-green-600' : 'text-gray-900'}`}>
                          {rec.recommended.pods} pods
                        </div>
                        <div className={rec.strategies.combined.cpuSavings > 0 ? 'text-green-600' : 'text-gray-900'}>
                          {rec.recommended.cpu} CPU × {rec.recommended.memory}GB
                        </div>
                        <div className="text-xs">
                          Total: {rec.strategies.combined.cpu} CPU, {rec.strategies.combined.memory}GB
                        </div>
                        {rec.strategies.combined.cpuSavings > 0 && (
                          <div className="text-xs text-green-600 font-medium">
                            💰 Save: {rec.strategies.combined.cpuSavings} CPU, {rec.strategies.combined.memorySavings}GB
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center text-xs">
                        <div>CPU: {rec.usage.avgCpuPercent}% / {rec.usage.maxCpuPercent}%</div>
                        <div>Mem: {rec.usage.avgMemoryPercent}% / {rec.usage.maxMemoryPercent}%</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${getRecommendationColor(rec.recommendation)}`}>
                          {getRecommendationIcon(rec.recommendation)}
                          {rec.recommendation.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div className="bg-blue-50 p-4 rounded-lg">
              <div className="text-2xl font-bold text-blue-600">{recommendations.length}</div>
              <div className="text-sm text-blue-600">Services</div>
            </div>
            <div className="bg-purple-50 p-4 rounded-lg">
              <div className="text-2xl font-bold text-purple-600">
                {recommendations.reduce((sum, r) => sum + r.pods.current, 0)}
              </div>
              <div className="text-sm text-purple-600">Total Pods</div>
            </div>
            <div className="bg-green-50 p-4 rounded-lg">
              <div className="text-2xl font-bold text-green-600">
                {recommendations.reduce((sum, r) => sum + Math.max(0, r.totalCluster.cpuSavings), 0)}
              </div>
              <div className="text-sm text-green-600">CPU Savings</div>
            </div>
            <div className="bg-orange-50 p-4 rounded-lg">
              <div className="text-2xl font-bold text-orange-600">
                {recommendations.reduce((sum, r) => sum + Math.max(0, r.totalCluster.memorySavings), 0)}
              </div>
              <div className="text-sm text-orange-600">Memory Savings (GB)</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default JavaServiceOptimizer;
