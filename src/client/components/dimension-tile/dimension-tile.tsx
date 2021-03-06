/*
 * Copyright 2015-2016 Imply Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('./dimension-tile.css');

import * as React from 'react';

import { Duration } from 'chronoshift';
import { List } from 'immutable';
import { $, r, Dataset, SortAction, TimeRange, RefExpression, Expression, TimeBucketAction, NumberRange } from 'plywood';

import { formatterFromData, collect, formatGranularity, formatTimeBasedOnGranularity, formatNumberRange } from '../../../common/utils/index';
import { Fn } from '../../../common/utils/general/general';
import { Clicker, Essence, Timekeeper, VisStrategy, Dimension, SortOn, SplitCombine, Filter, FilterSelection, FilterMode,
  Colors, Granularity, ContinuousDimensionKind, getBestGranularityForRange, granularityEquals,
  granularityToString, getDefaultGranularityForKind, getGranularities } from '../../../common/models/index';

import { setDragGhost, classNames } from '../../utils/dom/dom';
import { QueryRunner } from '../../utils/query-runner/query-runner';
import { DragManager } from '../../utils/drag-manager/drag-manager';
import { STRINGS, getLocale } from '../../config/constants';
import { PIN_TITLE_HEIGHT, PIN_ITEM_HEIGHT, PIN_PADDING_BOTTOM, MAX_SEARCH_LENGTH, SEARCH_WAIT } from '../../config/constants';

import { SvgIcon } from '../svg-icon/svg-icon';
import { Checkbox } from '../checkbox/checkbox';
import { Loader } from '../loader/loader';
import { QueryError } from '../query-error/query-error';
import { HighlightString } from '../highlight-string/highlight-string';
import { SearchableTile, TileAction } from '../searchable-tile/searchable-tile';
import { TileHeaderIcon } from "../tile-header/tile-header";

const TOP_N = 100;
const FOLDER_BOX_HEIGHT = 30;

export interface DimensionTileProps extends React.Props<any> {
  clicker: Clicker;
  essence: Essence;
  timekeeper: Timekeeper;
  dimension: Dimension;
  sortOn: SortOn;
  colors?: Colors;
  onClose?: any;
  getUrlPrefix?: () => string;
}

export interface DimensionTileState {
  loading?: boolean;
  dataset?: Dataset;
  error?: any;
  fetchQueued?: boolean;
  unfolded?: boolean;
  foldable?: boolean;
  showSearch?: boolean;
  searchText?: string;
  selectedGranularity?: Granularity;
  filterMode?: FilterMode;
}

export class DimensionTile extends React.Component<DimensionTileProps, DimensionTileState> {
  public mounted: boolean;
  public collectTriggerSearch: Fn;

  constructor() {
    super();
    this.state = {
      loading: false,
      dataset: null,
      error: null,
      fetchQueued: false,
      unfolded: true,
      foldable: false,
      showSearch: false,
      selectedGranularity: null,
      searchText: ''
    };

    this.collectTriggerSearch = collect(SEARCH_WAIT, () => {
      if (!this.mounted) return;
      var { essence, timekeeper, dimension, sortOn } = this.props;
      var { unfolded } = this.state;
      this.fetchData(essence, timekeeper, dimension, sortOn, unfolded);
    });

  }

  fetchData(essence: Essence, timekeeper: Timekeeper, dimension: Dimension, sortOn: SortOn, unfolded: boolean, selectedGranularity?: Granularity): void {
    var { searchText } = this.state;
    var { dataCube, colors } = essence;

    var filter = essence.getEffectiveFilter(timekeeper);
    // don't remove filter if time
    if (unfolded && dataCube.isMandatoryFilter(dimension.expression)) {
      filter = filter.remove(dimension.expression);
    }

    filter = filter.setExclusionforDimension(false, dimension);

    var filterExpression = filter.toExpression();

    if (!unfolded && colors && colors.dimension === dimension.name && colors.values) {
      filterExpression = filterExpression.and(dimension.expression.in(colors.toSet()));
    }

    if (searchText) {
      filterExpression = filterExpression.and(dimension.expression.contains(r(searchText), 'ignoreCase'));
    }

    var query: any = $('main')
      .filter(filterExpression);

    var sortExpression: Expression = null;

    if (dimension.canBucketByDefault()) {
      const dimensionExpression = dimension.expression as RefExpression;
      const attributeName = dimensionExpression.name;

      const filterSelection: FilterSelection = essence.filter.getSelection(dimensionExpression);

      if (!selectedGranularity) {
        if (filterSelection) {
          var range = dimension.kind === 'time' ? essence.evaluateSelection(filterSelection as Expression, timekeeper) : (filterSelection as Expression).getLiteralValue().extent();
          selectedGranularity = getBestGranularityForRange(range, true, dimension.bucketedBy, dimension.granularities);
        } else {
          selectedGranularity = getDefaultGranularityForKind(dimension.kind as ContinuousDimensionKind, dimension.bucketedBy, dimension.granularities);
        }
      }

      this.setState({ selectedGranularity });

      query = query.split($(attributeName).performAction(selectedGranularity), dimension.name);
      sortExpression = $(dimension.name);
    } else {
      query = query.split(dimension.expression, dimension.name);
      sortExpression = sortOn.getExpression();
    }

    if (sortOn.measure) {
      query = query.performAction(sortOn.measure.toApplyAction());
    }

    query = query.sort(sortExpression, SortAction.DESCENDING).limit(TOP_N + 1);

    this.setState({
      loading: true,
      fetchQueued: false
    });
    QueryRunner.fetch(dataCube, query, essence.timezone)
      .then(
        (dataset: Dataset) => {
          if (!this.mounted) return;
          this.setState({
            loading: false,
            dataset,
            error: null
          });
        },
        (error) => {
          if (!this.mounted) return;
          this.setState({
            loading: false,
            dataset: null,
            error
          });
        }
      );
  }

  updateFoldability(essence: Essence, dimension: Dimension, colors: Colors): boolean {
    var { unfolded } = this.state;
    var foldable = true;
    if (essence.filter.filteredOn(dimension.expression)) { // has filter
      if (colors) {
        foldable = false;
        unfolded = false;
      } else if (dimension.kind === "time") {
        foldable = false;
        unfolded = true;
      }
    } else {
      if (!colors) {
        foldable = false;
        unfolded = true;
      }
    }

    this.setState({ foldable, unfolded });
    return unfolded;
  }

  componentWillMount() {
    var { essence, timekeeper, dimension, colors, sortOn } = this.props;
    var unfolded = this.updateFoldability(essence, dimension, colors);
    this.fetchData(essence, timekeeper, dimension, sortOn, unfolded);
  }

  componentWillReceiveProps(nextProps: DimensionTileProps) {
    var { essence, timekeeper, dimension, sortOn } = this.props;
    var { selectedGranularity } = this.state;
    var nextEssence = nextProps.essence;
    var nextTimekeeper = nextProps.timekeeper;
    var nextDimension = nextProps.dimension;
    var nextColors = nextProps.colors;
    var nextSortOn = nextProps.sortOn;
    var unfolded = this.updateFoldability(nextEssence, nextDimension, nextColors);

    // keep granularity selection if measures change or if autoupdate
    var currentSelection = essence.getPrimaryTimeSelection();
    var nextSelection = nextEssence.getPrimaryTimeSelection();
    var differentTimeFilterSelection = currentSelection ? !currentSelection.equals(nextSelection) : Boolean(nextSelection);
    if (differentTimeFilterSelection) {
      // otherwise render will try to format exiting dataset based off of new granularity (before fetchData returns)
      this.setState({ dataset: null });
    }

    var persistedGranularity = differentTimeFilterSelection ? null : selectedGranularity;

    if (
      essence.differentDataCube(nextEssence) ||
      essence.differentEffectiveFilter(nextEssence, timekeeper, nextTimekeeper, null, unfolded ? dimension : null) ||
      essence.differentColors(nextEssence) || !dimension.equals(nextDimension) || !sortOn.equals(nextSortOn) ||
      essence.differentTimezoneMatters(nextEssence) ||
      (!essence.timezone.equals(nextEssence.timezone)) && dimension.kind === 'time' ||
      differentTimeFilterSelection
    ) {
      this.fetchData(nextEssence, nextTimekeeper, nextDimension, nextSortOn, unfolded, persistedGranularity);
    }

    this.setFilterModeFromProps(nextProps);
  }

  setFilterModeFromProps(props: DimensionTileProps) {
    if (props.colors) {
      this.setState({filterMode: Filter.INCLUDED});
    } else {
      var filterMode = props.essence.filter.getModeForDimension(props.dimension);
      if (filterMode) this.setState({filterMode});
    }
  }

  componentDidMount() {
    this.mounted = true;

    this.setFilterModeFromProps(this.props);
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  onRowClick(value: any, e: MouseEvent) {
    var { clicker, essence, dimension, colors } = this.props;
    var { dataset, filterMode } = this.state;
    var { filter } = essence;

    if (colors && colors.dimension === dimension.name) {
      if (colors.limit) {
        if (!dataset) return;
        var values = dataset.data.slice(0, colors.limit).map((d) => d[dimension.name]);
        colors = Colors.fromValues(colors.dimension, values);
      }
      colors = colors.toggle(value);
      if (filter.filteredOn(dimension.expression)) {
        filter = filter.toggleValue(dimension.expression, value);
        clicker.changeFilter(filter, colors);
      } else {
        clicker.changeColors(colors);
      }

    } else {
      if (e.altKey || e.ctrlKey || e.metaKey) {
        let filteredOnMe = filter.filteredOnValue(dimension.expression, value);
        let singleFilter = filter.getLiteralSet(dimension.expression).size() === 1;

        if (filteredOnMe && singleFilter) {
          filter = filter.remove(dimension.expression);
        } else {
          filter = filter.remove(dimension.expression).addValue(dimension.expression, value);
        }
      } else {
        filter = filter.toggleValue(dimension.expression, value);
      }

      // If no longer filtered switch unfolded to true for later
      var { unfolded } = this.state;
      if (!unfolded && !filter.filteredOn(dimension.expression)) {
        this.setState({ unfolded: true });
      }

      clicker.changeFilter(filter.setExclusionforDimension(filterMode === Filter.EXCLUDED, dimension));
    }
  }

  changeFilterMode(value: FilterMode) {
    const { clicker, essence, dimension } = this.props;
    this.setState({filterMode: value}, () => {
      clicker.changeFilter(essence.filter.setExclusionforDimension(value === Filter.EXCLUDED, dimension));
    });
  }

  getFilterActions(): TileAction[] {
    const { essence, dimension } = this.props;
    const { filterMode } = this.state;

    if (!essence || !dimension) return null;

    const filter: Filter = essence.filter;

    const options: FilterMode[] = [Filter.INCLUDED, Filter.EXCLUDED];

    return options.map((value) => {
      return {
        selected: filterMode === value,
        onSelect: this.changeFilterMode.bind(this, value),
        displayValue: (STRINGS as any)[value],
        keyString: value
      };
    });
  }

  toggleFold() {
    var { essence, timekeeper, dimension, sortOn } = this.props;
    var { unfolded } = this.state;
    unfolded = !unfolded;
    this.setState({ unfolded });
    this.fetchData(essence, timekeeper, dimension, sortOn, unfolded);
  }

  onDragStart(e: DragEvent) {
    var { essence, dimension, getUrlPrefix } = this.props;

    var newUrl = essence.changeSplit(SplitCombine.fromExpression(dimension.expression), VisStrategy.FairGame).getURL(getUrlPrefix());

    var dataTransfer = e.dataTransfer;
    dataTransfer.effectAllowed = 'all';
    dataTransfer.setData("text/url-list", newUrl);
    dataTransfer.setData("text/plain", newUrl);
    DragManager.setDragDimension(dimension, 'dimension-tile');
    setDragGhost(dataTransfer, dimension.title);
  }

  toggleSearch() {
    var { showSearch } = this.state;
    this.setState({ showSearch: !showSearch });
    this.onSearchChange('');
  }

  onSearchChange(text: string) {
    var { searchText, dataset, fetchQueued, loading } = this.state;
    var newSearchText = text.substr(0, MAX_SEARCH_LENGTH);

    if (searchText === newSearchText) return; // nothing to do;

    // If the user is just typing in more and there are already < TOP_N results then there is nothing to do
    if (newSearchText.indexOf(searchText) !== -1 && !fetchQueued && !loading && dataset && dataset.data.length < TOP_N) {
      this.setState({
        searchText: newSearchText
      });
      return;
    }

    this.setState({
      searchText: newSearchText,
      fetchQueued: true
    });
    this.collectTriggerSearch();
  }

  getTitleHeader(): string {
    const { dimension } = this.props;
    const { selectedGranularity } = this.state;

    if (selectedGranularity && dimension.kind === 'time') {
      var duration = (selectedGranularity as TimeBucketAction).duration;
      return `${dimension.title} (${duration.getDescription()})`;
    }
    return dimension.title;
  }

  onSelectGranularity(selectedGranularity: Granularity) {
    if (selectedGranularity === this.state.selectedGranularity) return;
    var { essence, timekeeper, dimension, colors, sortOn } = this.props;
    var unfolded = this.updateFoldability(essence, dimension, colors);
    this.setState({ dataset: null });
    this.fetchData(essence, timekeeper, dimension, sortOn, unfolded, selectedGranularity);
  }

  getGranularityActions(): TileAction[] {
    const { dimension } = this.props;
    const { selectedGranularity } = this.state;
    var granularities = dimension.granularities || getGranularities(dimension.kind as ContinuousDimensionKind, dimension.bucketedBy, true);
    return granularities.map((g) => {
      var granularityStr = granularityToString(g);
      return {
        selected: granularityEquals(selectedGranularity, g),
        onSelect: this.onSelectGranularity.bind(this, g),
        displayValue: formatGranularity(granularityStr),
        keyString: granularityStr
      };
    });
  }

  render() {
    const { clicker, essence, dimension, sortOn, colors, onClose } = this.props;
    const { loading, dataset, error, showSearch, unfolded, foldable, fetchQueued, searchText, selectedGranularity, filterMode } = this.state;

    const measure = sortOn.measure;
    const measureName = measure ? measure.name : null;
    const filterSet = essence.filter.getLiteralSet(dimension.expression);
    const continuous = dimension.isContinuous();
    const excluded = filterMode === Filter.EXCLUDED;

    var maxHeight = PIN_TITLE_HEIGHT;

    var rows: Array<JSX.Element> = [];
    var folder: JSX.Element = null;
    var highlightControls: JSX.Element = null;
    var hasMore = false;
    if (dataset) {
      hasMore = dataset.data.length > TOP_N;
      var rowData = dataset.data.slice(0, TOP_N);

      if (!unfolded) {
        if (filterSet) {
          rowData = rowData.filter((d) => filterSet.contains(d[dimension.name]));
        }

        if (colors) {
          if (colors.values) {
            var colorsSet = colors.toSet();
            rowData = rowData.filter((d) => colorsSet.contains(d[dimension.name]));
          } else {
            rowData = rowData.slice(0, colors.limit);
          }
        }
      }

      if (searchText) {
        var searchTextLower = searchText.toLowerCase();
        rowData = rowData.filter((d) => {
          return String(d[dimension.name]).toLowerCase().indexOf(searchTextLower) !== -1;
        });
      }

      var colorValues: string[] = null;
      if (colors) colorValues = colors.getColors(rowData.map(d => d[dimension.name]));

      var formatter = measure ? formatterFromData(rowData.map(d => d[measureName] as number), measure.getFormat()) : null;
      rows = rowData.map((d, i) => {
        var segmentValue = d[dimension.name];
        var segmentValueStr = String(segmentValue);

        var className = 'row';
        var checkbox: JSX.Element = null;
        if ((filterSet || colors) && !continuous) {
          var selected: boolean;
          if (colors) {
            selected = false;
            className += ' color';
          } else {
            selected = essence.filter.filteredOnValue(dimension.expression, segmentValue);
            className += ' ' + (selected ? 'selected' : 'not-selected');
          }
          checkbox = <Checkbox
            selected={selected}
            type={excluded ? 'cross' : 'check'}
            color={colorValues ? colorValues[i] : null}
          />;
        }

        if (segmentValue instanceof TimeRange) {
          segmentValueStr = formatTimeBasedOnGranularity(segmentValue, (selectedGranularity as TimeBucketAction).duration, essence.timezone, getLocale());
        } else if (segmentValue instanceof NumberRange) {
          segmentValueStr = formatNumberRange(segmentValue);
        }

        var measureValueElement: JSX.Element = null;
        if (measure) {
          measureValueElement = <div className="measure-value">{formatter(d[measureName] as number)}</div>;
        }

        var row = <div
          className={className}
          key={segmentValueStr}
          onClick={this.onRowClick.bind(this, segmentValue)}
        >
          <div className="segment-value" title={segmentValueStr}>
            {checkbox}
            <HighlightString className="label" text={segmentValueStr} highlight={searchText}/>
          </div>
          {measureValueElement}
          {selected ? highlightControls : null}
        </div>;
        if (selected && highlightControls) highlightControls = null; // place only once
        return row;
      });
      maxHeight += Math.max(2, rows.length) * PIN_ITEM_HEIGHT;

      if (foldable) {
        folder = <div
          className={classNames('folder', unfolded ? 'folded' : 'unfolded')}
          onClick={this.toggleFold.bind(this)}
        >
          <SvgIcon svg={require('../../icons/caret.svg')}/>
          {unfolded ? 'Show selection' : 'Show all'}
        </div>;
        maxHeight += FOLDER_BOX_HEIGHT;
      }
    }

    maxHeight += PIN_PADDING_BOTTOM;

    var message: JSX.Element = null;
    if (!loading && dataset && !fetchQueued && searchText && !rows.length) {
      message = <div className="message">{`No results for "${searchText}"`}</div>;
    }

    const className = classNames(
      'dimension-tile',
      filterMode,
      (folder ? 'has-folder' : 'no-folder'),
      (colors ? 'has-colors' : 'no-colors'),
      {continuous}
    );

    const style = {
      maxHeight
    };

    var icons: TileHeaderIcon[] = [{
      name: 'search',
      ref: 'search',
      onClick: this.toggleSearch.bind(this),
      svg: require('../../icons/full-search.svg'),
      active: showSearch
    }];

    if (onClose !== null) {
      icons.push({
        name: 'close',
        ref: 'close',
        onClick: onClose,
        svg: require('../../icons/full-remove.svg')
      });
    }

    var actions: TileAction[] = null;

    if (dimension.canBucketByDefault()) {
      actions = this.getGranularityActions();
    } else if (!continuous && !essence.colors) {
      actions = this.getFilterActions();
    }

    return <SearchableTile
      style={style}
      title={this.getTitleHeader()}
      toggleChangeFn={this.toggleSearch.bind(this)}
      onDragStart={this.onDragStart.bind(this)}
      onSearchChange={this.onSearchChange.bind(this)}
      searchText={searchText}
      showSearch={showSearch}
      icons={icons}
      className={className}
      actions={actions}
      >
      <div className="rows">
        {rows}
        {message}
      </div>
      { folder }
      {error ? <QueryError error={error}/> : null}
      {loading ? <Loader/> : null}
    </SearchableTile>;

  }
}
